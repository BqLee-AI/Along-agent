import { readLatestRunSnapshotPayload } from '../../../features/conversations/public.js';
import type { PoolClient } from 'pg';
import {
  HarnessR3SnapshotSchema,
  HistoricalHarnessSnapshotSchema,
  type GoalResult,
  type HarnessRequest,
} from '@along/contracts';
import type { ThreadEvent } from '@along/stream-protocol';
import { ApplicationError, forbidden, stateConflict } from '../../../platform/errors.js';
import { validateDocumentApprovalsDone } from '../../../features/approvals/public.js';
import { readRunDocumentEvidence } from '../../tools/evidence/run-evidence.js';
import {
  hasBlockingInvocationFailure,
  readRunInvocationStates,
} from '../../tools/invocations/run-state.js';
import {
  readRoutingRecord,
  routingHash,
  type RoutingRenderPayload,
} from '../../routing/routing-checkpoints.js';
import { approvalAuthorizesActions, type AttemptEnvironment } from '../attempt/state.js';
import { persistAttemptOutput } from './private-output.js';
import { validateGoalResult } from './goal-result.js';
import { readRunApprovalDecision } from '../load-approval-decision.js';
import { commitTerminal } from './commit.js';

/** Complete terminal use cases; all evidence and facts use the attempt's guarded client. */
export function createFinishHandlers(
  environment: AttemptEnvironment,
  send: (event: ThreadEvent, privateOutput?: boolean) => Promise<void>,
  directInvocation: (client: PoolClient, invocationId: string) => Promise<void>,
) {
  const { context, initial, state: attemptState, guarded } = environment;
  const eventPayload = (context: AttemptEnvironment['context']) => ({
    conversation_id: context.conversationId,
    run_id: context.runId,
  });
  async function finishGoal(request: Extract<HarnessRequest, { type: 'finish_goal' }>) {
    if (context.executionProfile === 'compact-memory/1') {
      if (!attemptState.nextPermit)
        throw stateConflict('goal completion requires a safe-point permit');
      attemptState.nextPermit = false;
    }
    if (!context.authorizationRevision || !attemptState.modelStarted)
      throw stateConflict('goal completion requires delegated model execution');
    if (
      request.usage.iterations !== attemptState.cumulative.iterations ||
      request.usage.tokens !== attemptState.cumulative.tokens
    )
      throw stateConflict('goal usage must match accepted model steps');
    if (
      request.usage.iterations > context.maxIterations ||
      (request.usage.tokens !== null && request.usage.tokens > context.maxTokens)
    )
      throw new ApplicationError(429, 'BUDGET_EXCEEDED', '本轮推理预算用完，已停下。');
    const result = await guarded(async (client) => {
      let goal: GoalResult;
      try {
        goal = await validateGoalResult(client, context, request.goal_result);
      } catch (error) {
        if (error instanceof ApplicationError && error.errorCode === 'STATE_CONFLICT')
          return {
            accepted: false as const,
            code: 'INVALID_GOAL_RESULT',
            message: error.message,
          };
        throw error;
      }
      // A supplied cancellation goal also contains model-controlled text.
      return persistAttemptOutput(client, context, () =>
        commitTerminal(client, context, goal.status === 'cancelled' ? 'cancelled' : 'done', {
          ...eventPayload(context),
          ...(goal.status === 'cancelled'
            ? { reason: 'harness_cancelled' }
            : { approval_id: null }),
          goal_result: goal,
          usage: attemptState.cumulative,
        }),
      );
    });
    if ('accepted' in result) {
      attemptState.correctingGoal = true;
      return result;
    }
    attemptState.stopped = true;
    await send(result.event, result.privateOutput);
    return { accepted: true };
  }
  async function finish(request: Extract<HarnessRequest, { type: 'finish' }>) {
    if (
      !context.compactControl &&
      (context.executionProfile === 'pause/1' ||
        context.executionProfile === 'pause-memory/1' ||
        context.executionProfile === 'compact-memory/1') &&
      request.outcome === 'done' &&
      attemptState.routingDecision?.payload.decision !== 'direct'
    ) {
      if (!attemptState.nextPermit) throw stateConflict('completion requires a safe-point permit');
      attemptState.nextPermit = false;
    }
    if (
      context.authorizationRevision &&
      request.outcome === 'done' &&
      attemptState.routingDecision?.payload.decision !== 'direct'
    )
      throw stateConflict('delegated goal requires finish_goal');
    if (
      attemptState.modelStarted &&
      (request.usage.iterations !== attemptState.cumulative.iterations ||
        request.usage.tokens !== attemptState.cumulative.tokens)
    )
      throw stateConflict('terminal usage must match accepted model steps');
    const { event, privateOutput } = await guarded(async (client) => {
      // Interruption only accounts for accepted effects and deltas. Use the
      // already validated in-memory usage baseline instead of reopening private state.
      const previous =
        request.outcome !== 'done' && context.feishuDocx
          ? null
          : await readLatestRunSnapshotPayload(client, context);
      const baseline = previous
        ? context.executionProfile === 'compact-memory/1'
          ? HarnessR3SnapshotSchema.parse(previous.payload)
          : HistoricalHarnessSnapshotSchema.parse(previous.payload)
        : attemptState.lastSnapshot;
      if (
        baseline &&
        (request.usage.iterations < baseline.usage.iterations ||
          (baseline.usage.tokens !== null &&
            request.usage.tokens !== null &&
            request.usage.tokens < baseline.usage.tokens) ||
          (baseline.usage.iterations > 0 &&
            baseline.usage.tokens === null &&
            request.usage.tokens !== null))
      )
        throw stateConflict('terminal usage cannot move backwards');
      if (request.outcome === 'done') {
        if (attemptState.routingDecision?.payload.decision === 'direct') {
          const render = await readRoutingRecord<RoutingRenderPayload>(
            client,
            context,
            'harness_routing_render',
          );
          if (
            attemptState.modelStarted ||
            attemptState.cumulative.iterations !== 0 ||
            attemptState.cumulative.tokens !== 0 ||
            request.usage.iterations !== 0 ||
            request.usage.tokens !== 0 ||
            !render ||
            render.payload.decision_ref !== attemptState.routingDecision.id
          )
            throw stateConflict(
              'routing completion requires accepted render receipt and zero model usage',
            );
          await directInvocation(client, render.payload.invocation_ref);
          const accepted = await readRunInvocationStates(client, context);
          if (
            accepted.length !== 1 ||
            accepted[0]?.state !== 'completed' ||
            accepted[0].outcome_kind !== 'success'
          )
            throw stateConflict('routing completion requires unique successful accepted result');
        }
        if (initial.approval?.kind === 'document' && !approvalAuthorizesActions(initial.approval))
          throw forbidden('rejected approval cannot complete the original action');
        if (
          request.usage.iterations > context.maxIterations ||
          (request.usage.tokens !== null && request.usage.tokens > context.maxTokens)
        )
          throw new ApplicationError(429, 'BUDGET_EXCEEDED', '本轮推理预算用完，已停下。');
        const states = await readRunInvocationStates(client, context);
        for (const row of states) {
          if (row.state !== 'completed' || hasBlockingInvocationFailure(row))
            throw stateConflict('Run has unresolved tool effects');
          if (
            row.outcome_kind === 'approval_pending' &&
            row.approval_id &&
            (await readRunApprovalDecision(client, context, row.invocation_id, row.approval_id))
              .status === 'pending'
          )
            throw stateConflict('Run has unresolved approval');
          if (
            row.outcome_kind === 'approval_pending' &&
            !initial.snapshot?.tool_refs.includes(row.invocation_id)
          )
            throw stateConflict('approval requires explicit suspension and resume');
        }
        await validateDocumentApprovalsDone(
          client,
          context,
          await readRunDocumentEvidence(client, context),
        );
        if (
          !attemptState.modelStarted &&
          attemptState.cumulative.iterations === 0 &&
          attemptState.routingDecision?.payload.decision !== 'direct'
        )
          throw stateConflict('zero-model completion requires accepted routing render receipt');
      }
      const prepareGoal =
        request.outcome === 'done' && context.authorizationRevision
          ? async (client: PoolClient, answer: string) => {
              const render = await readRoutingRecord<RoutingRenderPayload>(
                client,
                context,
                'harness_routing_render',
              );
              if (!render) throw stateConflict('routing render missing');
              if (routingHash(answer) !== render.payload.body_sha256)
                throw stateConflict('routing answer differs from accepted render');
              return validateGoalResult(client, context, {
                status: 'completed',
                outcomes: [
                  {
                    description: '完成本次有限只读查询',
                    status: 'achieved',
                    receipt_refs: [render.payload.invocation_ref],
                  },
                ],
                clarification: null,
                answer,
              });
            }
          : undefined;
      const payload =
        request.outcome === 'done'
          ? {
              ...eventPayload(context),
              approval_id: null,
            }
          : request.outcome === 'cancelled'
            ? { ...eventPayload(context), reason: 'harness_cancelled' }
            : {
                ...eventPayload(context),
                error: {
                  code: request.error?.code ?? 'HARNESS_EXITED',
                  message: request.error?.message ?? '原生执行失败。',
                  http_status: request.error?.code === 'BUDGET_EXCEEDED' ? 429 : 500,
                },
              };
      return persistAttemptOutput(
        client,
        context,
        () =>
          commitTerminal(
            client,
            context,
            request.outcome,
            {
              ...payload,
              ...(context.authorizationRevision ? { usage: attemptState.cumulative } : {}),
            },
            { prepareGoal },
          ),
        request.outcome === 'done',
      );
    });
    attemptState.stopped = true;
    await send(event, privateOutput);
    return { accepted: true };
  }
  return { finishGoal, finish };
}
