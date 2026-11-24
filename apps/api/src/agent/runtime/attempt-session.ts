import {
  hasBlockingInvocationFailure,
  readRunInvocationIdentities,
  readRunInvocationStates,
} from '../tools/invocations/run-state.js';
import {
  listPendingApprovalRuns,
  hasPendingPauseWithinTransaction,
  writeHarnessSnapshotWithinTransaction,
  readLatestAttemptSnapshotId,
  suspendRunWithinTransaction,
  lockRun,
  type LockedRun,
  appendEvent,
  stagePrivateDisclosure,
  releasePrivateDisclosure,
} from '../../features/conversations/public.js';
import { createFinishHandlers } from '../operations/finish-attempt.js';
import { decodeHarnessRequest, decodeCurrentSnapshot } from '../harness/frame-codec.js';
import { createModelHandlers } from './attempt-model.js';
import { createToolHandlers } from './attempt-tools.js';
import type { AttemptState } from './attempt-state.js';
import type { PoolClient } from 'pg';
import {
  HARNESS_R3_PROTOCOL_VERSION,
  HARNESS_CONTEXT_PROTOCOL_VERSION,
  HARNESS_MAX_FRAME_BYTES,
  type HarnessRequest,
  type HarnessR3ContextStart,
  type HarnessStart,
  RoutingEmbeddingSchema,
} from '@along/contracts';
import type { ThreadEvent } from '@along/stream-protocol';
import { ApplicationError, forbidden, stateConflict } from '../../platform/errors.js';
import { hasRejectedDocumentApproval } from '../../features/approvals/public.js';
import { readInvocationSnapshots } from '../tools/invocations/invocations.js';
import { readRunContextSource } from '../tools/invocations/context-query.js';
import { assertContextSourcesAuthorized } from '../tools/invocations/context-source.js';
import { GOAL_CONTROL_TOOL } from '../tools/goal-control.js';
import { validateWorkspaceGrant } from '../../features/workspaces/public.js';
import type { ConversationDeps, EventWriter, RunContext } from './contracts.js';
import { routingRuntimeOf } from './config.js';
import { withRunTransaction } from './run-ownership.js';
import {
  readRoutingRecord,
  acceptRoutingDecision,
  decisionPayload,
  routingDecisionReply,
  insertRoutingRender,
  routingHash,
  type RoutingDecisionPayload,
  type RoutingRenderPayload,
} from '../routing/routing-checkpoints.js';
import { readSnapshot } from './run-snapshot.js';
import { readRunApprovalDecision } from '../operations/run-approval-decision.js';
import { createPauseHandlers } from './attempt-pause.js';
import { guardHarnessStart, loadHarnessSession } from './attempt-load.js';
import { validateRoutingFacts } from './attempt-routing.js';
import { createSnapshotValidator } from './attempt-snapshot.js';
import { buildHarnessStart, poolOf, toolContext } from './context.js';
import { requireCurrentFeishuBotAuthority } from '../tools/invocations/accepted-result.js';
import { authorizePrivateOutput } from './private-output.js';
import type { NativeHandoff, NativeReplyHandoff } from '../harness/harness-process.js';

export const sessionAborts = new Map<string, Set<AbortController>>();

export interface HarnessSession {
  start: HarnessStart | HarnessR3ContextStart;
  guardStart: NativeHandoff;
  guardReply: NativeReplyHandoff;
  handleRequest(request: HarnessRequest): Promise<unknown>;
  close(): Promise<void>;
}

function eventPayload(context: RunContext) {
  return { conversation_id: context.conversationId, run_id: context.runId };
}

// The public test seam exercises the same guarded frame handler used by the
// real native process; production always calls it through runNativeHarness.
export async function createHarnessSession(
  deps: ConversationDeps,
  supplied: RunContext,
  write: EventWriter,
  signal: AbortSignal,
  privateDelivery: 'inline' | 'subscription' = 'inline',
): Promise<HarnessSession> {
  const pool = poolOf(deps);
  const initial = await loadHarnessSession(pool, deps, supplied);
  const { context } = initial;
  const start = buildHarnessStart(
    context,
    initial.snapshot,
    initial.observations,
    initial.approval,
    initial.policy?.payload.policy ?? null,
    initial.eligible ? 'fresh_first_step' : 'disabled',
  );
  const tools = context.authorizationRevision ? [...start.tools, GOAL_CONTROL_TOOL] : start.tools;
  const attemptState: AttemptState = {
    stopped: false,
    correctingGoal:
      (initial.snapshot?.version === 3 || initial.snapshot?.version === 4) &&
      initial.snapshot.native_state.closing_goal,
    lastSnapshot: initial.snapshot,
    delivered: new Set(initial.snapshot?.tool_refs ?? []),
    cumulative: { ...(initial.snapshot?.usage ?? { iterations: 0, tokens: 0 }) },
    facts: null,
    embedding: null,
    encodingCount: 0,
    encodingPending: false,
    routingDecision: initial.decision,
    modelStarted:
      (initial.snapshot?.version === 3 || initial.snapshot?.version === 4) &&
      initial.snapshot.usage.iterations > 0,
    latestModelMessage:
      initial.snapshot?.version === 3 || initial.snapshot?.version === 4
        ? initial.snapshot.native_state.pending_model
        : null,
    modelToolCount: initial.snapshot?.tool_refs.length ?? 0,
    nextPermit: false,
    lastModelInputTokens: null,
    lastMeasurement: null,
    modelStream: null,
  };
  const sessionController = new AbortController();
  const sessionSignal = AbortSignal.any([signal, sessionController.signal]);
  const modelController = new AbortController();
  const modelSignal = AbortSignal.any([sessionSignal, modelController.signal]);
  const controllers = sessionAborts.get(context.runId) ?? new Set<AbortController>();
  controllers.add(sessionController);
  sessionAborts.set(context.runId, controllers);
  const routing = routingRuntimeOf(deps);
  const policy = initial.policy?.payload.policy ?? null;
  async function guarded<T>(
    action: (client: PoolClient, locked: LockedRun) => Promise<T>,
  ): Promise<T> {
    if (attemptState.stopped || sessionSignal.aborted)
      throw stateConflict('harness attempt stopped');
    return withRunTransaction(pool, context.ownership, async (client) => {
      const locked = await lockRun(client, context);
      if (attemptState.stopped || sessionSignal.aborted)
        throw stateConflict('harness attempt stopped');
      if (context.workspaceGrant) validateWorkspaceGrant(context.ownerId, context.workspaceGrant);
      return action(client, locked);
    });
  }
  async function assertActionAuthority(client: PoolClient): Promise<void> {
    if (
      context.authorizationRevision === 'delegation/1' &&
      (await hasRejectedDocumentApproval(client, context))
    )
      throw forbidden('rejected document approval cannot authorize another action');
  }
  async function routingEligible(client: PoolClient, locked: LockedRun): Promise<void> {
    if (
      !initial.eligible ||
      !policy ||
      policy.mode === 'off' ||
      locked.attempt.attempt_no !== 1 ||
      attemptState.modelStarted ||
      attemptState.lastSnapshot ||
      attemptState.cumulative.iterations !== 0 ||
      attemptState.cumulative.tokens !== 0 ||
      attemptState.routingDecision
    )
      throw stateConflict('routing requires fresh first step');
    if ((await readRunInvocationStates(client, toolContext(context))).length)
      throw stateConflict('routing must precede tool reservation');
  }
  async function directInvocation(client: PoolClient, invocationId: string): Promise<void> {
    const decision = attemptState.routingDecision?.payload;
    if (!decision || decision.decision !== 'direct')
      throw stateConflict('routing direct decision missing');
    const rows = await readRunInvocationIdentities(client, context);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      row.invocation_id !== invocationId ||
      row.first_attempt_id !== context.attemptId ||
      row.call_key !== 'harness/1' ||
      row.execution_kind !== 'read_only' ||
      row.tool_id !== decision.tool_id ||
      row.args_hash !== decision.args_hash
    )
      throw stateConflict('routing direct requires unique original invocation');
  }
  async function send(event: ThreadEvent, privateOutput = false): Promise<void> {
    if (privateOutput && privateDelivery === 'subscription') return;
    if (privateOutput && write.ready && !(await write.ready()))
      throw stateConflict('client disconnected');
    const open = privateOutput
      ? await withRunTransaction(pool, context.ownership, async (client) => {
          // Terminal facts have already committed; a delta still needs a running attempt.
          await lockRun(client, context, event.type === 'message.delta');
          await requireCurrentFeishuBotAuthority(client, context);
          if (sessionSignal.aborted) throw stateConflict('harness attempt stopped');
          // Hand off to the sink while revocation is still blocked on the grant/session locks.
          const open = await write(event, 'held');
          if (open) await releasePrivateDisclosure(client, event);
          return open;
        })
      : await write(event);
    if (!open) throw stateConflict('client disconnected');
  }
  const validateSnapshot = createSnapshotValidator(context, attemptState);
  const pauseHandlers = createPauseHandlers(
    context,
    attemptState,
    guarded,
    assertActionAuthority,
    validateSnapshot,
  );
  const environment = {
    pool,
    deps,
    context,
    initial,
    state: attemptState,
    tools,
    guarded,
    assertActionAuthority,
    sessionSignal,
    modelSignal,
    modelController,
  };
  const modelHandlers = createModelHandlers(environment);
  const toolHandlers = createToolHandlers(environment, directInvocation, send);
  const finishHandlers = createFinishHandlers(environment, send, directInvocation);
  return {
    start,
    guardStart: (enqueue) =>
      guardHarnessStart(pool, context, initial.snapshot, sessionSignal, enqueue),
    guardReply: async (request, result, enqueue) => {
      const potentiallyPrivate =
        request.type === 'invoke' ||
        request.type === 'context_source' ||
        request.type === 'model' ||
        request.type === 'model_next';
      if (!context.feishuDocx || !potentiallyPrivate || !result) {
        enqueue();
        return;
      }
      await guarded(async (client) => {
        if (request.type === 'context_source')
          await assertContextSourcesAuthorized(
            client,
            { ...toolContext(context), signal: sessionSignal },
            [request.invocation_id],
          );
        else await authorizePrivateOutput(client, context);
        sessionSignal.throwIfAborted();
        enqueue();
      });
    },
    close: async () => {
      attemptState.stopped = true;
      sessionController.abort();
      controllers.delete(sessionController);
      if (!controllers.size && sessionAborts.get(context.runId) === controllers)
        sessionAborts.delete(context.runId);
      await modelHandlers.close();
    },
    handleRequest: async (suppliedRequest) => {
      try {
        const request = decodeHarnessRequest(suppliedRequest, start.protocol);
        if (
          context.compactControl &&
          !(['pause_probe', 'pause_point', 'finish'] as const).some((type) => type === request.type)
        )
          throw stateConflict('compact control cannot execute conversational actions');
        if (
          context.compactControl &&
          request.type === 'finish' &&
          request.outcome === 'done' &&
          (!initial.snapshot || !initial.compact)
        )
          throw stateConflict('compact control requires a published successor');
        await guarded(async () => undefined);
        if (attemptState.modelStream && request.type === 'finish' && request.outcome !== 'done')
          await modelHandlers.close();
        if (attemptState.modelStream && request.type !== 'model_next' && request.type !== 'answer')
          throw stateConflict('model stream must complete before another action');
        if (
          (request.type === 'pause_probe' || request.type === 'pause_point') &&
          !(
            ((context.executionProfile === 'pause/1' ||
              context.executionProfile === 'pause-memory/1') &&
              request.protocol === HARNESS_R3_PROTOCOL_VERSION) ||
            (context.executionProfile === 'compact-memory/1' &&
              request.protocol === HARNESS_CONTEXT_PROTOCOL_VERSION)
          )
        )
          throw stateConflict('pause protocol not enabled for Run');
        if (request.type === 'pause_probe') return pauseHandlers.pauseProbe(request);
        if (request.type === 'pause_point') return await pauseHandlers.pausePoint(request);
        if (request.type === 'route_probe') {
          if (request.stage === 'facts') {
            return await guarded(async (client, locked) => {
              await routingEligible(client, locked);
              if (attemptState.facts || attemptState.encodingCount || attemptState.encodingPending)
                throw stateConflict('routing facts probe out of order');
              const pending = await listPendingApprovalRuns(client, context);
              let hasPendingApproval = false;
              for (const run of pending) {
                const decision = await readRunApprovalDecision(
                  client,
                  {
                    ownerId: context.ownerId,
                    conversationId: context.conversationId,
                    runId: run.id,
                  },
                  run.waiting_invocation_id,
                  run.waiting_approval_id,
                );
                if (decision.status === 'pending') hasPendingApproval = true;
              }
              attemptState.facts = validateRoutingFacts(
                routing.facts(
                  {
                    messageId: context.userMessageId!,
                    text: context.inputText,
                    messages: context.messages!.map(({ role, content }) => ({ role, content })),
                    hasPendingApproval,
                    workspaceSelected:
                      !!context.workspaceGrant || !!context.workspaceGrants?.length,
                  },
                  policy!,
                ),
                context,
                policy,
              );
              return structuredClone(attemptState.facts);
            });
          }
          const cached = await guarded(async (client, locked) => {
            await routingEligible(client, locked);
            if (
              !attemptState.facts ||
              request.facts_ref !== attemptState.facts.facts_ref ||
              !attemptState.facts.eligible ||
              attemptState.facts.rule_intent !== null ||
              attemptState.encodingCount ||
              attemptState.encodingPending
            )
              throw stateConflict('routing embedding probe out of order');
            attemptState.encodingCount = 1;
            attemptState.encodingPending = true;
            return attemptState.facts;
          });
          try {
            const encoded = RoutingEmbeddingSchema.parse(
              await routing.embedding(context.inputText, cached, policy!, sessionSignal),
            );
            return await guarded(async (client, locked) => {
              await routingEligible(client, locked);
              if (
                encoded.facts_ref !== cached.facts_ref ||
                encoded.input_sha256 !== cached.input_sha256 ||
                encoded.bundle_sha256 !== cached.bundle_sha256
              )
                throw stateConflict('routing embedding evidence binding conflict');
              attemptState.embedding = encoded;
              return structuredClone(encoded);
            });
          } finally {
            attemptState.encodingPending = false;
          }
        }
        if (request.type === 'route_decide') {
          const accepted = await guarded(async (client, locked) => {
            if (
              attemptState.encodingPending ||
              !attemptState.facts ||
              request.facts_ref !== attemptState.facts.facts_ref ||
              !initial.policy ||
              !policy ||
              policy.mode === 'off'
            )
              throw stateConflict('routing decision requires cached completed evidence');
            const candidate =
              request.decision === 'direct'
                ? (attemptState.facts.candidates.find(
                    (entry) => entry.intent === request.candidate_intent,
                  ) ?? null)
                : null;
            const payload = decisionPayload(
              context,
              initial.policy.id,
              attemptState.facts,
              attemptState.embedding,
              attemptState.encodingCount,
              request.decision,
              request.reason,
              candidate,
            );
            const previous = await readRoutingRecord<RoutingDecisionPayload>(
              client,
              context,
              'harness_routing_decision',
            );
            if (previous) {
              if (request.candidate_intent !== previous.payload.intent)
                throw stateConflict('routing decision is immutable');
              return acceptRoutingDecision(client, context, payload);
            }
            if (
              context.executionProfile === 'pause/1' ||
              context.executionProfile === 'pause-memory/1' ||
              context.executionProfile === 'compact-memory/1'
            ) {
              const pending = await hasPendingPauseWithinTransaction(client, context);
              if (pending) return null;
            }
            await routingEligible(client, locked);
            if (request.decision === 'fallback') {
              if (request.candidate_intent !== null)
                throw stateConflict('fallback cannot authorize candidate');
            } else {
              if (
                !candidate ||
                !attemptState.facts.eligible ||
                policy.mode !== 'enforce' ||
                !policy.direct_intents.includes(candidate.intent) ||
                !context.allowlist.includes(candidate.tool_id) ||
                routing.choose(attemptState.facts, attemptState.embedding, policy) !==
                  candidate.intent
              )
                throw forbidden(
                  'routing direct not authorized by cached evidence and frozen policy',
                );
            }
            return acceptRoutingDecision(client, context, payload);
          });
          if (!accepted) return { pause_requested: true };
          attemptState.routingDecision = accepted;
          return routingDecisionReply(accepted);
        }
        if (request.type === 'render_route_result') {
          const prepared = await guarded(async (client) => {
            if (
              !attemptState.routingDecision ||
              attemptState.routingDecision.payload.decision !== 'direct' ||
              request.decision_ref !== attemptState.routingDecision.id ||
              !policy ||
              policy.mode === 'off' ||
              request.template_revision !== policy.renderer_revision ||
              attemptState.modelStarted ||
              !attemptState.lastSnapshot ||
              attemptState.lastSnapshot.waiting ||
              attemptState.lastSnapshot.tool_refs.length !== 1 ||
              attemptState.lastSnapshot.tool_refs[0] !== request.invocation_ref ||
              attemptState.lastSnapshot.usage.iterations !== 0 ||
              attemptState.lastSnapshot.usage.tokens !== 0 ||
              !attemptState.delivered.has(request.invocation_ref)
            )
              throw stateConflict(
                'routing render requires accepted result and zero-model snapshot',
              );
            await directInvocation(client, request.invocation_ref);
            const previous = await readRoutingRecord<RoutingRenderPayload>(
              client,
              context,
              'harness_routing_render',
            );
            if (previous) {
              if (
                previous.payload.decision_ref !== request.decision_ref ||
                previous.payload.invocation_ref !== request.invocation_ref ||
                previous.payload.template_revision !== request.template_revision
              )
                throw stateConflict('routing render is immutable');
              return null;
            }
            const accepted = (
              await readInvocationSnapshots(client, toolContext(context), [request.invocation_ref])
            )[0];
            if (!accepted || accepted.result.status !== 'ok')
              throw stateConflict('routing requires successful accepted result');
            return accepted.result;
          });
          if (prepared === null) return { rendered: true };
          // Pure projection and all byte/chunk preparation deliberately happen outside locks.
          let text: string;
          try {
            text = routing.render(attemptState.routingDecision!.payload.intent!, prepared);
          } catch (error) {
            if (error instanceof Error && error.message === 'ROUTING_RENDER_CAPACITY')
              throw new ApplicationError(
                422,
                'HARNESS_CONTEXT_LIMIT',
                '只读结果超过完整展示容量。',
              );
            throw error;
          }
          if (!text || Buffer.byteLength(text, 'utf8') > HARNESS_MAX_FRAME_BYTES)
            throw new ApplicationError(422, 'HARNESS_CONTEXT_LIMIT', '只读结果超过完整展示容量。');
          const chunks: string[] = [];
          let chunk = '';
          for (const scalar of text) {
            if (chunk.length + scalar.length > 4000) {
              chunks.push(chunk);
              chunk = '';
            }
            chunk += scalar;
          }
          if (chunk) chunks.push(chunk);
          const events = await guarded(async (client) => {
            await directInvocation(client, request.invocation_ref);
            if (await readRoutingRecord(client, context, 'harness_routing_render'))
              throw stateConflict('routing render already accepted');
            const events: ThreadEvent[] = [];
            for (const delta of chunks)
              events.push(
                await appendEvent(client, context, 'message.delta', {
                  ...eventPayload(context),
                  delta,
                }),
              );
            await insertRoutingRender(client, context, {
              decision_ref: request.decision_ref,
              invocation_ref: request.invocation_ref,
              template_revision: request.template_revision,
              body_sha256: routingHash(text),
              chunk_count: chunks.length,
            });
            return events;
          });
          for (const event of events) {
            await guarded(async () => undefined);
            await send(event);
          }
          return { rendered: true };
        }
        if (
          attemptState.routingDecision?.payload.decision === 'direct' &&
          (request.type === 'model' ||
            request.type === 'measure_context' ||
            request.type === 'model_next' ||
            request.type === 'suspend' ||
            request.type === 'answer')
        )
          throw forbidden('routing direct cannot call model or accept native answer');
        if (
          initial.eligible &&
          !attemptState.routingDecision &&
          (request.type === 'model' ||
            request.type === 'measure_context' ||
            request.type === 'reserve' ||
            request.type === 'invoke')
        )
          throw stateConflict('routing requires terminal decision before original path');
        if (request.type === 'model_next') return modelHandlers.next(request);
        if (request.type === 'context_source') {
          if (!attemptState.delivered.has(request.invocation_id))
            throw forbidden('context source outside accepted Run references');
          const observation = await guarded((client) =>
            readRunContextSource(client, toolContext(context), request.invocation_id, request.view),
          );
          await guarded(async () => undefined);
          return observation;
        }
        if (request.type === 'model' || request.type === 'measure_context')
          return await modelHandlers.model(request);
        if (request.type === 'reserve') return await toolHandlers.reserve(request);
        if (request.type === 'invoke') return await toolHandlers.invoke(request);
        if (request.type === 'snapshot') {
          const snapshot = decodeCurrentSnapshot(request.context);
          const id = await guarded(async (client) => {
            await validateSnapshot(client, snapshot);
            return writeHarnessSnapshotWithinTransaction(client, context, snapshot, start.protocol);
          });
          attemptState.lastSnapshot = snapshot;
          return { checkpoint_ref: id };
        }
        if (request.type === 'suspend') {
          await guarded(async (client, locked) => {
            await assertActionAuthority(client);
            const latest = await readLatestAttemptSnapshotId(client, context.attemptId);
            if (latest !== request.checkpoint_ref)
              throw stateConflict('suspend requires latest attempt checkpoint');
            const snapshot = await readSnapshot(client, locked.run, request.checkpoint_ref);
            await validateSnapshot(client, snapshot);
            if (
              snapshot.waiting?.invocation_id !== request.invocation_id ||
              snapshot.waiting.approval_id !== request.approval_id
            )
              throw stateConflict('suspend waiting reference conflict');
            if (initial.snapshot?.tool_refs.includes(request.invocation_id))
              throw stateConflict('original approval waiting point cannot suspend again');
            const states = await readRunInvocationStates(client, toolContext(context));
            if (
              states.some((row) => row.state !== 'completed' || hasBlockingInvocationFailure(row))
            )
              throw stateConflict('cannot suspend unresolved tool effects');
            await suspendRunWithinTransaction(client, context, {
              checkpointId: request.checkpoint_ref,
              invocationId: request.invocation_id,
              approvalId: request.approval_id,
            });
          });
          attemptState.stopped = true;
          return { suspended: true };
        }
        if (request.type === 'answer') {
          if (
            !attemptState.modelStream ||
            attemptState.modelStream.pendingDelta === null ||
            request.delta !== attemptState.modelStream.pendingDelta
          )
            throw stateConflict('native answer must match the accepted model delta');
          const { event, privateOutput } = await guarded(async (client) => {
            const privateOutput = await authorizePrivateOutput(client, context);
            const event = await appendEvent(client, context, 'message.delta', {
              ...eventPayload(context),
              delta: request.delta,
            });
            if (privateOutput) await stagePrivateDisclosure(client, event);
            return { event, privateOutput };
          });
          await send(event, privateOutput);
          if (attemptState.modelStream) attemptState.modelStream.pendingDelta = null;
          return { accepted: true };
        }
        if (request.type === 'finish_goal') return await finishHandlers.finishGoal(request);
        if (request.type !== 'finish') throw stateConflict('unsupported terminal control');
        return await finishHandlers.finish(request);
      } catch (error) {
        if (
          suppliedRequest.type === 'route_probe' ||
          suppliedRequest.type === 'route_decide' ||
          suppliedRequest.type === 'render_route_result' ||
          attemptState.routingDecision?.payload.decision === 'direct'
        ) {
          attemptState.stopped = true;
          sessionController.abort();
        }
        throw error;
      }
    },
  };
}
