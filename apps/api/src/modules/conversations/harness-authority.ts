import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  HARNESS_PROTOCOL_VERSION,
  HARNESS_MAX_FRAME_BYTES,
  HarnessSnapshotSchema,
  HistoricalHarnessSnapshotSchema,
  HarnessStartSchema,
  HarnessModelStepSchema,
  type HarnessModelStep,
  type HarnessRequest,
  type HarnessSnapshot,
  type HarnessStart,
  type HarnessApprovalDecision,
  type RunView,
} from '@along/contracts';
import { THREAD_PROTOCOL_VERSION } from '@along/stream-protocol';
import type { ThreadEvent } from '@along/stream-protocol';
import { withTransaction } from '../../db/transaction.js';
import {
  HttpError,
  forbidden,
  notReady,
  stateConflict,
  validationError,
} from '../../http/errors.js';
import { validateDocumentApprovalsDone } from '../approvals/document-service.js';
import { invokeTool, reserveToolInvocation } from '../tools/gateway.js';
import { readRunInvocationStates } from '../tools/invocations.js';
import {
  readRunContextObservations,
  readRunContextSource,
  readRunDocumentEvidence,
} from '../tools/query.js';
import type { ToolContext, ToolPayload } from '../tools/contracts.js';
import { HARNESS_BASE_TOOL_IDS, TOOL_IDS } from '../tools/contracts.js';
import { HARNESS_TOOL_DEFINITIONS } from '../tools/catalog.js';
import { validateWorkspaceGrant } from '../workspaces/service.js';
import { runNativeHarness } from './harness-process.js';
import type { ConversationDeps, EventWriter, RunContext, StartResult } from './contracts.js';
import { ensureRunContextPolicy, readRunContextPolicy } from './context-policy.js';
import { measureHarnessContext } from './harness-context.js';
import { CancelRunBodySchema, ResumeRunBodySchema } from './schemas.js';
import {
  insertAttempt,
  latestAttemptId,
  listRunEvents,
  lockRun,
  type LockedRun,
  type RunRow,
  readHarnessMessages,
} from './repository.js';
import {
  appendEvent,
  commitTerminal,
  readSnapshot,
  readRunApprovalDecision,
  viewOf,
} from './run-state.js';

export interface HarnessSession {
  start: HarnessStart;
  handleRequest(request: HarnessRequest): Promise<unknown>;
  close(): Promise<void>;
}

const active = new Map<string, AbortController>();

function poolOf(deps: ConversationDeps): Pool {
  if (!deps.pool) throw notReady();
  return deps.pool;
}
function unavailable(): HttpError {
  return new HttpError(503, 503, 'HARNESS_UNAVAILABLE', '原生 Agent 暂不可用。');
}
function isStale(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.errorCode === 'STATE_CONFLICT' &&
    typeof error.details === 'object' &&
    error.details !== null &&
    'reason' in error.details &&
    error.details.reason === 'STALE_ATTEMPT'
  );
}

async function withLatest<T>(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  action: (client: PoolClient, locked: LockedRun) => Promise<T>,
  authorize = true,
): Promise<T> {
  const pool = poolOf(deps);
  for (;;) {
    const attemptId = await latestAttemptId(pool, ownerId, runId);
    try {
      return await withTransaction(pool, async (client) => {
        const locked = await lockRun(
          client,
          { ownerId, conversationId, runId, attemptId },
          false,
          authorize,
        );
        return action(client, locked);
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
        throw stateConflict('action idempotency key conflict');
      if (!isStale(error)) throw error;
      // resume committed after our discovery; relocate without replaying effects.
    }
  }
}

async function contextOf(
  client: PoolClient,
  deps: ConversationDeps,
  run: RunRow,
  attemptId: string,
  requestId: string,
  checkpointId?: string,
): Promise<RunContext> {
  const frozen = run.frozen_context;
  if (!frozen || !run.input_message_id) throw stateConflict('Run accepted input missing');
  const message = (
    await client.query<{ content: string }>(
      `SELECT content FROM messages WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND role='user'`,
      [run.input_message_id, run.owner_id, run.conversation_id],
    )
  ).rows[0];
  if (!message) throw stateConflict('Run accepted message missing');
  if (
    deps.timeContext.ruleset_id !== frozen.rulesetId ||
    deps.timeContext.tzdb_version !== frozen.tzdbVersion ||
    (frozen.aliasVersion !== null &&
      (!deps.timeContext.available || deps.timeContext.aliases.version !== frozen.aliasVersion))
  )
    throw new HttpError(503, 503, 'TZDB_UNAVAILABLE', '接纳时的时间规则暂不可用。');
  if (frozen.workspaceGrant) validateWorkspaceGrant(run.owner_id, frozen.workspaceGrant);
  const contextPolicy = await readRunContextPolicy(client, run.owner_id, run.id);
  const deployed = deps.harness?.contextPolicy;
  if (
    !contextPolicy ||
    !deployed ||
    contextPolicy.model_binding.model !== deployed.model_binding.model ||
    contextPolicy.model_binding.adapter_revision !== deployed.model_binding.adapter_revision
  )
    throw unavailable();
  const messageRefs = frozen.messageRefs ?? [run.input_message_id];
  const messages = await readHarnessMessages(
    client,
    {
      ownerId: run.owner_id,
      conversationId: run.conversation_id,
      userMessageId: run.input_message_id,
    },
    messageRefs,
  );
  return {
    ownerId: run.owner_id,
    conversationId: run.conversation_id,
    runId: run.id,
    attemptId,
    requestId,
    execution: run.execution,
    userMessageId: run.input_message_id,
    inputText: message.content,
    confirmedTimezone: frozen.confirmedTimezone,
    anchorReceivedAtUtc: frozen.anchorReceivedAtUtc,
    receivedAtUtc: frozen.receivedAtUtc,
    foldChoice: frozen.foldChoice,
    timeContext: deps.timeContext,
    maxIterations: run.budget_max_iterations,
    maxTokens: run.budget_max_tokens,
    allowlist: run.tools_allowlist.filter((name) =>
      ((frozen.workspaceGrant ? TOOL_IDS : HARNESS_BASE_TOOL_IDS) as readonly string[]).includes(
        name,
      ),
    ),
    ...(frozen.workspaceGrant ? { workspaceGrant: frozen.workspaceGrant } : {}),
    messageRefs,
    messages,
    contextPolicy,
    ...(checkpointId ? { resumeCheckpointId: checkpointId } : {}),
  };
}
function eventPayload(context: RunContext) {
  return { conversation_id: context.conversationId, run_id: context.runId };
}
function toolContext(context: RunContext): ToolContext {
  return context;
}

function approvalAuthorizesActions(decision: HarnessApprovalDecision | null): boolean {
  return (
    decision === null ||
    (decision.kind === 'task' ? decision.status === 'consumed' : decision.status === 'approved')
  );
}

function buildHarnessStart(
  context: RunContext,
  snapshot: HarnessSnapshot | null,
  observations: HarnessStart['observations'],
  approval: HarnessApprovalDecision | null,
): HarnessStart {
  if (!context.contextPolicy || !context.messages) throw unavailable();
  if (
    snapshot &&
    (snapshot.message_refs.length !== context.messages.length ||
      snapshot.message_refs.some((id, index) => id !== context.messages![index]?.message_id))
  )
    throw stateConflict('snapshot message reference conflict');
  const start: HarnessStart = {
    protocol: HARNESS_PROTOCOL_VERSION,
    type: 'start',
    messages: context.messages,
    context_policy: context.contextPolicy,
    tools: HARNESS_TOOL_DEFINITIONS.filter((tool) => context.allowlist.includes(tool.name)),
    budget: { max_iterations: context.maxIterations, max_tokens: context.maxTokens },
    snapshot,
    observations,
    approval,
    workspace: context.workspaceGrant
      ? validateWorkspaceGrant(context.ownerId, context.workspaceGrant)
      : null,
  };
  if (Buffer.byteLength(JSON.stringify(start), 'utf8') > HARNESS_MAX_FRAME_BYTES)
    throw new HttpError(422, 422, 'HARNESS_CONTEXT_LIMIT', '工具上下文超过安全范围，已停下。');
  return HarnessStartSchema.parse(start);
}

export async function getRunView(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
): Promise<RunView> {
  return withLatest(deps, ownerId, conversationId, runId, viewOf);
}

export async function cancelConversationRun(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  requestId: string,
  body: unknown,
): Promise<RunView> {
  const parsed = CancelRunBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid cancel body');
  const input = parsed.data;
  const reason = input.reason ?? 'user_cancelled';
  const result = await withLatest(
    deps,
    ownerId,
    conversationId,
    runId,
    async (client, locked) => {
      const previous = (
        await client.query<{ run_id: string; reason: string }>(
          'SELECT run_id,reason FROM harness_cancellations WHERE owner_id=$1 AND idempotency_key=$2',
          [ownerId, input.idempotency_key],
        )
      ).rows[0];
      if (previous && (previous.run_id !== runId || previous.reason !== reason))
        throw stateConflict('cancel idempotency key conflict');
      if (!previous)
        await client.query(
          'INSERT INTO harness_cancellations(owner_id,idempotency_key,run_id,reason) VALUES($1,$2,$3,$4)',
          [ownerId, input.idempotency_key, runId, reason],
        );
      if (locked.run.status === 'running' || locked.run.status === 'suspended_approval') {
        await commitTerminal(
          client,
          { ownerId, conversationId, runId, attemptId: locked.attempt.id, requestId },
          'cancelled',
          {
            conversation_id: conversationId,
            run_id: runId,
            reason,
          },
        );
        locked.run.status = 'cancelled';
        locked.run.waiting_checkpoint_id = null;
        locked.run.waiting_invocation_id = null;
        locked.run.waiting_approval_id = null;
        locked.attempt.status = 'failed';
      }
      return viewOf(client, locked);
    },
    false,
  );
  // Qualification has already been revoked durably before model/pipe abort.
  if (result.status === 'cancelled') active.get(runId)?.abort();
  return result;
}

export async function resumeConversationRun(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  runId: string,
  requestId: string,
  body: unknown,
): Promise<StartResult> {
  const parsed = ResumeRunBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid resume body');
  const input = parsed.data;
  return withLatest(deps, ownerId, conversationId, runId, async (client, locked) => {
    const prior = (
      await client.query<{ run_id: string; checkpoint_id: string; attempt_id: string }>(
        'SELECT run_id,checkpoint_id,attempt_id FROM harness_resumes WHERE owner_id=$1 AND idempotency_key=$2',
        [ownerId, input.idempotency_key],
      )
    ).rows[0];
    if (prior) {
      if (prior.run_id !== runId || prior.checkpoint_id !== input.checkpoint_id)
        throw stateConflict('resume idempotency key conflict');
      const attempt = (
        await client.query<{ status: string }>('SELECT status FROM run_attempts WHERE id=$1', [
          prior.attempt_id,
        ])
      ).rows[0];
      if (attempt?.status === 'running')
        throw stateConflict('resumed Run still running', {
          status: 'running',
          run_id: runId,
          attempt_id: prior.attempt_id,
        });
      const events = await listRunEvents(client, ownerId, runId);
      const seqs = (
        await client.query<{ event_seq: string }>(
          'SELECT event_seq FROM run_checkpoints WHERE attempt_id=$1',
          [prior.attempt_id],
        )
      ).rows.map((row) => Number(row.event_seq));
      const selected = new Set(seqs);
      return {
        conversationId,
        runId,
        context: null,
        replay: events.filter((event) => selected.has(event.seq)),
      };
    }
    const run = locked.run;
    if (
      run.execution !== 'harness' ||
      run.status !== 'suspended_approval' ||
      run.waiting_checkpoint_id !== input.checkpoint_id ||
      !run.waiting_approval_id
    )
      throw stateConflict('Run has no matching approval waiting point', { status: run.status });
    const used = await client.query('SELECT 1 FROM harness_resumes WHERE checkpoint_id=$1', [
      input.checkpoint_id,
    ]);
    if (used.rowCount) throw stateConflict('approval waiting point already resumed');
    const snapshot = await readSnapshot(client, run, input.checkpoint_id);
    if (
      !snapshot.waiting ||
      snapshot.waiting.invocation_id !== run.waiting_invocation_id ||
      snapshot.waiting.approval_id !== run.waiting_approval_id
    )
      throw stateConflict('waiting checkpoint reference conflict');
    const decision = await readRunApprovalDecision(
      client,
      { ownerId, conversationId, runId },
      snapshot.waiting.invocation_id,
      run.waiting_approval_id,
    );
    if (decision.status === 'pending')
      throw stateConflict('approval still pending', { status: 'pending' });
    if (!deps.harness) throw unavailable();
    if (
      snapshot.usage.iterations >= run.budget_max_iterations ||
      (snapshot.usage.tokens !== null && snapshot.usage.tokens >= run.budget_max_tokens)
    )
      throw new HttpError(429, 429, 'BUDGET_EXCEEDED', '原运行预算已用完，不能继续。');
    const attemptId = randomUUID();
    await ensureRunContextPolicy(client, ownerId, runId, deps.harness.contextPolicy);
    const context = await contextOf(client, deps, run, attemptId, requestId, input.checkpoint_id);
    const observations = await readRunContextObservations(
      client,
      toolContext(context),
      snapshot.tool_refs,
      { project: context.allowlist.includes('read_run_observation') },
    );
    buildHarnessStart(context, snapshot, observations, decision);
    await insertAttempt(client, {
      attemptId,
      ownerId,
      runId,
      attemptNo: locked.attempt.attempt_no + 1,
    });
    await client.query(
      'INSERT INTO harness_resumes(owner_id,idempotency_key,run_id,checkpoint_id,attempt_id) VALUES($1,$2,$3,$4,$5)',
      [ownerId, input.idempotency_key, runId, input.checkpoint_id, attemptId],
    );
    await client.query(
      `UPDATE agent_runs SET status='running',waiting_checkpoint_id=NULL,
      waiting_invocation_id=NULL,waiting_approval_id=NULL WHERE id=$1`,
      [runId],
    );
    return { conversationId, runId, context, replay: null };
  });
}

// The public test seam exercises the same guarded frame handler used by the
// real native process; production always calls it through runNativeHarness.
export async function createHarnessSession(
  deps: ConversationDeps,
  supplied: RunContext,
  write: EventWriter,
  signal: AbortSignal,
): Promise<HarnessSession> {
  const pool = poolOf(deps);
  const initial = await withTransaction(pool, async (client) => {
    const locked = await lockRun(client, supplied);
    if (locked.run.execution !== 'harness') throw stateConflict('not a harness Run');
    const resume = (
      await client.query<{ checkpoint_id: string }>(
        'SELECT checkpoint_id FROM harness_resumes WHERE attempt_id=$1 AND run_id=$2 AND owner_id=$3',
        [supplied.attemptId, supplied.runId, supplied.ownerId],
      )
    ).rows[0];
    const context = await contextOf(
      client,
      deps,
      locked.run,
      supplied.attemptId,
      supplied.requestId,
      resume?.checkpoint_id,
    );
    const snapshot = resume ? await readSnapshot(client, locked.run, resume.checkpoint_id) : null;
    const observations = snapshot
      ? await readRunContextObservations(client, toolContext(context), snapshot.tool_refs, {
          project: context.allowlist.includes('read_run_observation'),
        })
      : [];
    const approval = snapshot?.waiting
      ? await readRunApprovalDecision(
          client,
          context,
          snapshot.waiting.invocation_id,
          snapshot.waiting.approval_id,
        )
      : null;
    return { context, snapshot, observations, approval };
  });
  const { context } = initial;
  const start = buildHarnessStart(
    context,
    initial.snapshot,
    initial.observations,
    initial.approval,
  );
  const tools = start.tools;
  let stopped = false;
  let lastSnapshot = initial.snapshot;
  const delivered = new Set(initial.snapshot?.tool_refs ?? []);
  const cumulative = { ...(initial.snapshot?.usage ?? { iterations: 0, tokens: 0 }) };
  const modelController = new AbortController();
  const modelSignal = AbortSignal.any([signal, modelController.signal]);
  let modelStarted = false;
  let modelStream: {
    ref: string;
    iterator: AsyncGenerator<HarnessModelStep, void, unknown>;
    pendingDelta: string | null;
    pulling: boolean;
  } | null = null;
  async function closeModel(): Promise<void> {
    modelController.abort();
    const current = modelStream;
    modelStream = null;
    // The pending next() owns any transport error; cleanup must not replace it.
    await current?.iterator.return().catch(() => undefined);
  }
  async function nextModelStep(): Promise<HarnessModelStep> {
    const current = modelStream;
    if (!current || current.pendingDelta !== null || current.pulling)
      throw stateConflict('model continuation requires an acknowledged previous delta');
    current.pulling = true;
    try {
      const next = await current.iterator.next();
      if (next.done)
        throw new HttpError(502, 502, 'HARNESS_PROTOCOL_ERROR', 'model ended without completion');
      const parsed = HarnessModelStepSchema.safeParse(next.value);
      if (!parsed.success)
        throw new HttpError(502, 502, 'HARNESS_PROTOCOL_ERROR', 'model step rejected');
      const step = parsed.data;
      await guarded(async () => undefined);
      if (step.type === 'delta') current.pendingDelta = step.delta;
      else {
        cumulative.iterations++;
        const usage = step.type === 'complete' ? step.reply.usage : step.usage;
        cumulative.tokens =
          cumulative.tokens === null || usage === null
            ? null
            : cumulative.tokens + usage.total_tokens;
        if (cumulative.tokens !== null && !Number.isSafeInteger(cumulative.tokens))
          throw new HttpError(502, 502, 'HARNESS_PROTOCOL_ERROR', 'model usage overflow');
        modelStream = null;
        await current.iterator.return();
      }
      return step;
    } catch (error) {
      await closeModel();
      throw error;
    } finally {
      current.pulling = false;
    }
  }
  async function guarded<T>(
    action: (client: PoolClient, locked: LockedRun) => Promise<T>,
  ): Promise<T> {
    if (stopped || signal.aborted) throw stateConflict('harness attempt stopped');
    return withTransaction(pool, async (client) => {
      const locked = await lockRun(client, context);
      if (context.workspaceGrant) validateWorkspaceGrant(context.ownerId, context.workspaceGrant);
      return action(client, locked);
    });
  }
  async function send(event: ThreadEvent): Promise<void> {
    if (!(await write(event))) throw stateConflict('client disconnected');
  }
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
  async function validateSnapshot(client: PoolClient, snapshot: HarnessSnapshot): Promise<void> {
    if (
      modelStarted &&
      (snapshot.usage.iterations !== cumulative.iterations ||
        snapshot.usage.tokens !== cumulative.tokens)
    )
      throw stateConflict('snapshot usage must match accepted model steps');
    const frozenRefs = context.messageRefs ?? [context.userMessageId];
    if (
      snapshot.message_refs.length !== frozenRefs.length ||
      snapshot.message_refs.some((ref, index) => ref !== frozenRefs[index])
    )
      throw stateConflict('snapshot message reference conflict');
    if (new Set(snapshot.tool_refs).size !== snapshot.tool_refs.length)
      throw stateConflict('duplicate snapshot tool reference');
    const states = await readRunInvocationStates(client, toolContext(context));
    const accepted = states.filter((row) => row.state === 'completed');
    if (
      accepted.length !== snapshot.tool_refs.length ||
      accepted.some((row) => !snapshot.tool_refs.includes(row.invocation_id))
    )
      throw stateConflict('snapshot must retain accepted Run invocations');
    const observations = await readRunContextObservations(
      client,
      toolContext(context),
      snapshot.tool_refs,
      { project: context.allowlist.includes('read_run_observation') },
    );
    const next = accepted.reduce((max, row) => {
      const match = /^harness\/([1-9]\d*)$/.exec(row.call_key);
      if (!match) throw stateConflict('invalid harness invocation slot');
      return Math.max(max, Number(match[1]) + 1);
    }, 1);
    if (snapshot.next_call_no !== next || snapshot.usage.iterations > context.maxIterations)
      throw stateConflict('snapshot usage or call counter conflict');
    const previous = (
      await client.query<{ payload: unknown }>(
        `SELECT c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
        WHERE a.run_id=$1 AND c.kind='harness_snapshot' ORDER BY c.event_seq DESC LIMIT 1`,
        [context.runId],
      )
    ).rows[0];
    const baseline = previous
      ? HistoricalHarnessSnapshotSchema.parse(previous.payload)
      : lastSnapshot;
    if (
      baseline &&
      (snapshot.next_call_no < baseline.next_call_no ||
        snapshot.usage.iterations < baseline.usage.iterations ||
        (baseline.usage.tokens !== null &&
          snapshot.usage.tokens !== null &&
          snapshot.usage.tokens < baseline.usage.tokens))
    )
      throw stateConflict('snapshot cannot move backwards');
    if (
      baseline &&
      baseline.usage.iterations > 0 &&
      baseline.usage.tokens === null &&
      snapshot.usage.tokens !== null
    )
      throw stateConflict('unknown cumulative token usage must remain unknown');
    const pending = accepted.filter((row) => row.outcome_kind === 'approval_pending');
    const unresolved = [];
    for (const row of pending) {
      if (!row.approval_id) throw stateConflict('missing approval reference');
      if (
        (await readRunApprovalDecision(client, context, row.invocation_id, row.approval_id))
          .status === 'pending'
      )
        unresolved.push(row);
    }
    if (snapshot.waiting) {
      const row = pending.find(
        (row) =>
          row.invocation_id === snapshot.waiting!.invocation_id &&
          row.approval_id === snapshot.waiting!.approval_id,
      );
      if (!row || !delivered.has(row.invocation_id))
        throw stateConflict('snapshot waiting reference conflict');
      if (unresolved.some((pending) => pending.invocation_id !== row.invocation_id))
        throw stateConflict('snapshot omits unresolved approval');
    } else if (unresolved.length) throw stateConflict('snapshot omits unresolved approval');
    buildHarnessStart(
      context,
      snapshot,
      observations,
      snapshot.waiting
        ? await readRunApprovalDecision(
            client,
            context,
            snapshot.waiting.invocation_id,
            snapshot.waiting.approval_id,
          )
        : null,
    );
  }
  return {
    start,
    close: closeModel,
    handleRequest: async (request) => {
      await guarded(async () => undefined);
      if (modelStream && request.type === 'finish' && request.outcome !== 'done')
        await closeModel();
      if (modelStream && request.type !== 'model_next' && request.type !== 'answer')
        throw stateConflict('model stream must complete before another action');
      if (request.type === 'model_next') {
        if (!modelStream || request.model_ref !== modelStream.ref)
          throw stateConflict('model continuation reference conflict');
        return nextModelStep();
      }
      if (request.type === 'context_source') {
        if (!delivered.has(request.invocation_id))
          throw forbidden('context source outside accepted Run references');
        const observation = await guarded((client) =>
          readRunContextSource(client, toolContext(context), request.invocation_id, request.view),
        );
        await guarded(async () => undefined);
        return observation;
      }
      if (request.type === 'model' || request.type === 'measure_context') {
        if (!approvalAuthorizesActions(initial.approval))
          throw forbidden('rejected approval cannot authorize another action');
        if (!deps.harness || !context.contextPolicy) throw unavailable();
        const remaining =
          cumulative.tokens === null ? null : Math.max(0, context.maxTokens - cumulative.tokens);
        if (request.remaining_tokens !== remaining)
          throw stateConflict('model balance must match accepted cumulative usage');
        if (cumulative.iterations >= context.maxIterations)
          throw new HttpError(429, 429, 'BUDGET_EXCEEDED', '本轮推理预算用完，已停下。');
        const measurement = (deps.harness.measure ?? measureHarnessContext)(
          { ...request, type: 'measure_context' },
          tools,
          context.contextPolicy,
        );
        if (request.type === 'measure_context') return measurement;
        if (measurement.limit_reason || request.max_output_tokens > measurement.output_ceiling) {
          const budget =
            measurement.limit_reason === 'budget' ||
            (remaining !== null && request.max_output_tokens > remaining);
          throw new HttpError(
            budget ? 429 : 422,
            budget ? 429 : 422,
            budget ? 'BUDGET_EXCEEDED' : 'HARNESS_CONTEXT_LIMIT',
            '模型请求超过本轮额度或容量。',
          );
        }
        await guarded(async (client) => {
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
        });
        modelStream = {
          ref: request.request_ref,
          iterator: deps.harness.model(request, tools, modelSignal)[Symbol.asyncIterator](),
          pendingDelta: null,
          pulling: false,
        };
        modelStarted = true;
        return nextModelStep();
      }
      if (request.type === 'reserve') {
        if (!approvalAuthorizesActions(initial.approval))
          throw forbidden('rejected approval cannot authorize another action');
        if (!context.allowlist.includes(request.tool_id))
          throw forbidden('tool outside frozen Run grant');
        await guarded(async (client) => {
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
            throw new HttpError(
              422,
              422,
              'HARNESS_CONTEXT_LIMIT',
              '工具引用达到安全上限，已停下。',
            );
          if (request.call_key !== `harness/${accepted + 1}`)
            throw stateConflict('invalid next harness slot');
        });
        const reserved = await reserveToolInvocation(
          pool,
          { ...toolContext(context), signal },
          {
            callKey: request.call_key,
            toolId: request.tool_id,
            args: request.args,
          },
        );
        await guarded(async () => undefined);
        return { invocation_id: reserved.invocationId };
      }
      if (request.type === 'invoke') {
        if (!approvalAuthorizesActions(initial.approval))
          throw forbidden('rejected approval cannot authorize another action');
        if (initial.snapshot?.tool_refs.includes(request.invocation_id))
          throw stateConflict('resume consumes stored observations without reinvoking them');
        await guarded(async (client) => {
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
          { ...toolContext(context), signal },
          {
            invocationId: request.invocation_id,
            toolId: request.tool_id,
            args: request.args,
          },
        );
        await guarded(async () => undefined);
        if (
          !delivered.has(outcome.invocationId) &&
          outcome.status === 'ok' &&
          (outcome.result.kind === 'approval' || outcome.result.kind === 'document_approval')
        )
          await approvalEvents(outcome.result);
        delivered.add(outcome.invocationId);
        return outcome;
      }
      if (request.type === 'snapshot') {
        const snapshot = HarnessSnapshotSchema.parse(request.context);
        const id = await guarded(async (client) => {
          await validateSnapshot(client, snapshot);
          const seq = (
            await client.query<{ seq: number }>(
              'SELECT COALESCE(max(seq),0)::int+1 AS seq FROM run_checkpoints WHERE attempt_id=$1',
              [context.attemptId],
            )
          ).rows[0]?.seq;
          const id = randomUUID();
          await client.query(
            `INSERT INTO run_checkpoints(id,owner_id,attempt_id,seq,kind,payload,stream_protocol_version)
          VALUES($1,$2,$3,$4,'harness_snapshot',$5::jsonb,$6)`,
            [
              id,
              context.ownerId,
              context.attemptId,
              seq,
              JSON.stringify(snapshot),
              HARNESS_PROTOCOL_VERSION,
            ],
          );
          return id;
        });
        lastSnapshot = snapshot;
        return { checkpoint_ref: id };
      }
      if (request.type === 'suspend') {
        await guarded(async (client, locked) => {
          const latest = (
            await client.query<{ id: string }>(
              `SELECT id FROM run_checkpoints WHERE attempt_id=$1 AND kind='harness_snapshot' ORDER BY seq DESC LIMIT 1`,
              [context.attemptId],
            )
          ).rows[0]?.id;
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
          if (states.some((row) => row.state !== 'completed' || row.outcome_kind === 'failed'))
            throw stateConflict('cannot suspend unresolved tool effects');
          await client.query(
            `UPDATE agent_runs SET status='suspended_approval',waiting_checkpoint_id=$2,
          waiting_invocation_id=$3,waiting_approval_id=$4 WHERE id=$1`,
            [context.runId, request.checkpoint_ref, request.invocation_id, request.approval_id],
          );
          await client.query(`UPDATE run_attempts SET status='done',ended_at=now() WHERE id=$1`, [
            context.attemptId,
          ]);
        });
        stopped = true;
        return { suspended: true };
      }
      if (request.type === 'answer') {
        if (modelStarted && (!modelStream || request.delta !== modelStream.pendingDelta))
          throw stateConflict('native answer must match the accepted model delta');
        const event = await guarded((client) =>
          appendEvent(client, context, 'message.delta', {
            ...eventPayload(context),
            delta: request.delta,
          }),
        );
        await send(event);
        if (modelStream) modelStream.pendingDelta = null;
        return { accepted: true };
      }
      if (
        modelStarted &&
        (request.usage.iterations !== cumulative.iterations ||
          request.usage.tokens !== cumulative.tokens)
      )
        throw stateConflict('terminal usage must match accepted model steps');
      const event = await guarded(async (client) => {
        const previous = (
          await client.query<{ payload: unknown }>(
            `SELECT c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
          WHERE a.run_id=$1 AND c.kind='harness_snapshot' ORDER BY c.event_seq DESC LIMIT 1`,
            [context.runId],
          )
        ).rows[0];
        const baseline = previous
          ? HistoricalHarnessSnapshotSchema.parse(previous.payload)
          : lastSnapshot;
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
          if (initial.approval?.kind === 'document' && !approvalAuthorizesActions(initial.approval))
            throw forbidden('rejected approval cannot complete the original action');
          if (
            request.usage.iterations > context.maxIterations ||
            (request.usage.tokens !== null && request.usage.tokens > context.maxTokens)
          )
            throw new HttpError(429, 429, 'BUDGET_EXCEEDED', '本轮推理预算用完，已停下。');
          const states = await readRunInvocationStates(client, toolContext(context));
          for (const row of states) {
            if (row.state !== 'completed' || row.outcome_kind === 'failed')
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
        }
        const payload =
          request.outcome === 'done'
            ? { ...eventPayload(context), approval_id: null }
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
        return commitTerminal(client, context, request.outcome, payload);
      });
      stopped = true;
      await send(event);
      return { accepted: true };
    },
  };
}

export async function executeHarness(
  deps: ConversationDeps,
  context: RunContext,
  write: EventWriter,
  signal?: AbortSignal,
): Promise<void> {
  const pool = poolOf(deps);
  if (!deps.harness) throw unavailable();
  const controller = new AbortController();
  active.set(context.runId, controller);
  let cancellation: Promise<unknown> | undefined;
  let cancellationFailure: { error: unknown } | undefined;
  let cancellationProjected = false;
  let closeSession: (() => Promise<void>) | undefined;
  const disconnected = () => {
    cancellation ??= cancelConversationRun(
      deps,
      context.ownerId,
      context.conversationId,
      context.runId,
      context.requestId,
      { idempotency_key: randomUUID(), reason: 'client_disconnected' },
    ).catch((error: unknown) => {
      cancellationFailure = { error };
    });
  };
  signal?.addEventListener('abort', disconnected, { once: true });
  try {
    if (signal?.aborted) {
      disconnected();
      await cancellation;
      return;
    }
    const session = await createHarnessSession(
      deps,
      context,
      async (event) => {
        const open = await write(event);
        if (open && event.type === 'thread.cancelled') cancellationProjected = true;
        if (!open) {
          disconnected();
          await cancellation;
        }
        return open;
      },
      controller.signal,
    );
    closeSession = session.close;
    if (session.start.snapshot === null) {
      const event = await withTransaction(pool, async (client) => {
        await lockRun(client, context);
        return appendEvent(client, context, 'thread.started', {
          ...eventPayload(context),
          stream_protocol_version: THREAD_PROTOCOL_VERSION,
          ruleset_id: context.timeContext.ruleset_id,
          tzdb_version: context.timeContext.tzdb_version,
        });
      });
      if (!(await write(event))) {
        disconnected();
        await cancellation;
        return;
      }
    }
    await runNativeHarness({
      services: deps.harness,
      start: session.start,
      signal: controller.signal,
      onExit: session.close,
      handleRequest: async (request) => {
        // No next native action may overtake a disconnect's durable decision.
        await cancellation;
        if (cancellationFailure) throw cancellationFailure.error;
        return session.handleRequest(request);
      },
    });
  } catch (error) {
    await cancellation;
    try {
      const failed = await withTransaction(pool, async (client) => {
        // Revocation rejects execution, but may not prevent recording its failure.
        await lockRun(client, context, true, false);
        const code = error instanceof HttpError ? error.errorCode : 'INTERNAL_ERROR';
        return commitTerminal(client, context, 'failed', {
          ...eventPayload(context),
          error: {
            code,
            message: error instanceof HttpError ? error.message : '原生执行失败。',
            http_status: error instanceof HttpError ? error.httpStatus : 500,
          },
        });
      });
      await write(failed);
    } catch {
      // Cancelled, suspended, stale or terminal authority wins; never overwrite.
    }
  } finally {
    await closeSession?.();
    signal?.removeEventListener('abort', disconnected);
    if (active.get(context.runId) === controller) active.delete(context.runId);
    // An explicit stop commits on another HTTP request. Project that existing
    // receipt to the still-open stream; never create a second terminal fact.
    if (controller.signal.aborted && !signal?.aborted && !cancellationProjected) {
      const events = await listRunEvents(pool, context.ownerId, context.runId);
      const cancelled = events.find((event) => event.type === 'thread.cancelled');
      if (cancelled) await write(cancelled);
    }
  }
}
