import type { PoolClient } from 'pg';
import type { HarnessRequest } from '@along/contracts';
import type { ThreadEvent } from '@along/stream-protocol';
import { ApplicationError, forbidden, stateConflict } from '../../platform/errors.js';
import { invokeTool, reserveToolInvocation } from '../tools/gateway.js';
import { readRunInvocationStates } from '../tools/invocations/run-state.js';
import type { ToolPayload } from '../tools/contracts.js';
import { appendEvent } from '../../features/conversations/public.js';
import { routingIdentity } from '../routing/routing-checkpoints.js';
import { toolContext } from './context.js';
import { approvalAuthorizesActions, type AttemptEnvironment } from './attempt-state.js';

/** Reservation and acceptance remain synchronous; there is no second execution queue. */
export function createToolHandlers(
  environment: AttemptEnvironment,
  directInvocation: (client: PoolClient, invocationId: string) => Promise<void>,
  send: (event: ThreadEvent) => Promise<void>,
) {
  const {
    pool,
    context,
    initial,
    state: attemptState,
    guarded,
    assertActionAuthority,
    sessionSignal,
  } = environment;
  const eventPayload = (context: AttemptEnvironment['context']) => ({
    conversation_id: context.conversationId,
    run_id: context.runId,
  });
  async function approvalEvents(
    payload: Extract<ToolPayload, { kind: 'approval' | 'document_approval' }>,
  ): Promise<void> {
    if (payload.kind === 'document_approval') {
      const event = await guarded((client) =>
        appendEvent(client, context, 'approval_required', {
          ...eventPayload(context),
          approval_id: payload.approval.approval_id,
          card_id: `document-approval:${payload.approval.approval_id}`,
          presentation_hash: payload.approval.presentation_hash,
        }),
      );
      await send(event);
      return;
    }
    const events = await guarded(async (client) => [
      await appendEvent(client, context, 'card.proposed', {
        ...eventPayload(context),
        card_id: payload.card_id,
        schema_version: 'v1',
        wall_time: payload.approval.wallTime,
        timezone_id: payload.approval.timezoneId,
        original_text: payload.original_text,
      }),
      await appendEvent(client, context, 'approval_required', {
        ...eventPayload(context),
        approval_id: payload.approval.approvalId,
        card_id: payload.card_id,
        presentation_hash: payload.approval.presentationHash,
      }),
    ]);
    for (const event of events) await send(event);
  }
  async function reserve(request: Extract<HarnessRequest, { type: 'reserve' }>) {
    if (
      context.executionProfile === 'pause/1' ||
      context.executionProfile === 'pause-memory/1' ||
      context.executionProfile === 'compact-memory/1'
    ) {
      if (!attemptState.nextPermit)
        throw stateConflict('tool reservation requires a safe-point permit');
      attemptState.nextPermit = false;
    }
    if (attemptState.correctingGoal)
      throw stateConflict('goal correction cannot reserve business actions');
    if (!approvalAuthorizesActions(initial.approval))
      throw forbidden('rejected approval cannot authorize another action');
    if (!context.allowlist.includes(request.tool_id))
      throw forbidden('tool outside frozen Run grant');
    if (
      attemptState.routingDecision?.payload.decision === 'direct' &&
      (request.call_key !== 'harness/1' ||
        request.tool_id !== attemptState.routingDecision.payload.tool_id ||
        routingIdentity(request.args) !==
          routingIdentity(attemptState.routingDecision.payload.args))
    )
      throw forbidden('routing direct must reserve original unique tool and arguments');
    await guarded(async (client) => {
      await assertActionAuthority(client);
      if (attemptState.routingDecision?.payload.decision === 'direct') {
        const states = await readRunInvocationStates(client, toolContext(context));
        if (
          states.length > 1 ||
          states.some(
            (state) =>
              state.call_key !== 'harness/1' ||
              state.tool_id !== attemptState.routingDecision!.payload.tool_id ||
              state.state !== 'reserved',
          )
        )
          throw stateConflict('routing direct cannot reserve a second slot');
      }
      const states = await readRunInvocationStates(client, toolContext(context));
      if (states.some((row) => row.state === 'unknown' || row.outcome_kind === 'failed'))
        throw stateConflict('Run has unresolved tool effects');
      if (
        states.some(
          (row) =>
            row.outcome_kind === 'approval_pending' &&
            !initial.snapshot?.tool_refs.includes(row.invocation_id),
        )
      )
        throw stateConflict('approval requires suspension before further actions');
      const accepted = states.filter((row) => row.state === 'completed').length;
      if (accepted >= 64)
        throw new ApplicationError(422, 'HARNESS_CONTEXT_LIMIT', '工具引用达到安全上限，已停下。');
      if (request.call_key !== `harness/${accepted + 1}`)
        throw stateConflict('invalid next harness slot');
    });
    const reservation = {
      callKey: request.call_key,
      toolId: request.tool_id,
      args: request.args,
    };
    const toolCtx = { ...toolContext(context), signal: sessionSignal };
    const reserved =
      attemptState.routingDecision?.payload.decision !== 'direct' &&
      (context.executionProfile === 'pause/1' ||
        context.executionProfile === 'pause-memory/1' ||
        context.executionProfile === 'compact-memory/1')
        ? await reserveToolInvocation(pool, toolCtx, reservation, { deferOnPause: true })
        : await reserveToolInvocation(pool, toolCtx, reservation);
    if ('pauseRequested' in reserved) return { pause_requested: true };
    await guarded(async () => undefined);
    return { invocation_id: reserved.invocationId };
  }
  async function invoke(request: Extract<HarnessRequest, { type: 'invoke' }>) {
    if (attemptState.correctingGoal)
      throw stateConflict('goal correction cannot invoke business actions');
    if (!approvalAuthorizesActions(initial.approval))
      throw forbidden('rejected approval cannot authorize another action');
    if (
      attemptState.routingDecision?.payload.decision === 'direct' &&
      (request.tool_id !== attemptState.routingDecision.payload.tool_id ||
        routingIdentity(request.args) !==
          routingIdentity(attemptState.routingDecision.payload.args))
    )
      throw forbidden('routing direct must invoke original tool and arguments');
    if (initial.snapshot?.tool_refs.includes(request.invocation_id))
      throw stateConflict('resume consumes stored observations without reinvoking them');
    await guarded(async (client) => {
      await assertActionAuthority(client);
      if (attemptState.routingDecision?.payload.decision === 'direct')
        await directInvocation(client, request.invocation_id);
      const states = await readRunInvocationStates(client, toolContext(context));
      if (states.some((row) => row.state === 'unknown' || row.outcome_kind === 'failed'))
        throw stateConflict('Run has unresolved tool effects');
      if (
        states.some(
          (row) =>
            row.outcome_kind === 'approval_pending' &&
            !initial.snapshot?.tool_refs.includes(row.invocation_id) &&
            row.invocation_id !== request.invocation_id,
        )
      )
        throw stateConflict('approval requires suspension before further actions');
    });
    const outcome = await invokeTool(
      pool,
      { ...toolContext(context), signal: sessionSignal },
      {
        invocationId: request.invocation_id,
        toolId: request.tool_id,
        args: request.args,
      },
    );
    await guarded(async () => undefined);
    if (
      !attemptState.delivered.has(outcome.invocationId) &&
      outcome.status === 'ok' &&
      (outcome.result.kind === 'approval' || outcome.result.kind === 'document_approval')
    )
      await approvalEvents(outcome.result);
    attemptState.delivered.add(outcome.invocationId);
    return outcome;
  }
  return { reserve, invoke };
}
