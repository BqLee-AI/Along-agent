import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  HARNESS_PROTOCOL_VERSION,
  HarnessSnapshotSchema,
  HarnessStartSchema,
  type HarnessRequest,
  type HarnessSnapshot,
  type HarnessStart,
  type HarnessTool,
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
import { readApprovalDecision } from '../approvals/decision.js';
import { invokeTool, reserveToolInvocation } from '../tools/gateway.js';
import { readInvocationSnapshots, readRunInvocationStates } from '../tools/invocations.js';
import type { ToolContext, ToolPayload } from '../tools/contracts.js';
import { TOOL_IDS } from '../tools/contracts.js';
import { runNativeHarness } from './harness-process.js';
import type { ConversationDeps, EventWriter, RunContext, StartResult } from './contracts.js';
import { CancelRunBodySchema, ResumeRunBodySchema } from './schemas.js';
import { insertAttempt, listRunEvents } from './repository.js';
import {
  appendEvent,
  commitTerminal,
  latestAttemptId,
  lockRun,
  readSnapshot,
  viewOf,
  type LockedRun,
  type RunRow,
} from './run-state.js';

export interface HarnessSession {
  start: HarnessStart;
  handleRequest(request: HarnessRequest): Promise<unknown>;
}

const active = new Map<string, AbortController>();
const parameters = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };
const TOOLS: readonly HarnessTool[] = [
  {
    name: 'propose_task',
    description: '提出提醒批准；只有用户在冻结确认页确认后才能创建任务。',
    risk: 'medium',
    parameters: parameters(
      {
        raw_time_text: string,
        timezone_hint: { type: ['string', 'null'] },
        note: string,
        occurrence: { const: 'once' },
      },
      ['raw_time_text', 'note', 'occurrence'],
    ),
  },
  {
    name: 'request_cancel_task',
    description: '提出已有任务的取消批准，不直接取消。',
    risk: 'medium',
    parameters: parameters(
      { task_id: { type: 'string', format: 'uuid' }, reason_text: { type: ['string', 'null'] } },
      ['task_id'],
    ),
  },
  {
    name: 'list_tasks',
    description: '读取当前用户提醒任务。',
    risk: 'low',
    parameters: parameters({
      state: {
        type: ['string', 'null'],
        enum: [
          'saved',
          'pending_schedule',
          'scheduled',
          'fired',
          'missed',
          'cancel_pending',
          'cancelled',
          null,
        ],
      },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    }),
  },
  {
    name: 'read_brief_cards',
    description: '读取当前用户指定日期的简报。',
    risk: 'low',
    parameters: parameters(
      {
        date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        card_ids: {
          type: ['array', 'null'],
          items: { type: 'string', format: 'uuid' },
          maxItems: 50,
        },
      },
      ['date'],
    ),
  },
  {
    name: 'get_user_prefs',
    description: '读取当前用户的时区与偏好。',
    risk: 'low',
    parameters: parameters({}),
  },
];

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
    allowlist: run.tools_allowlist.filter((name) => (TOOL_IDS as readonly string[]).includes(name)),
    ...(checkpointId ? { resumeCheckpointId: checkpointId } : {}),
  };
}
function eventPayload(context: RunContext) {
  return { conversation_id: context.conversationId, run_id: context.runId };
}
function toolContext(context: RunContext): ToolContext {
  return context;
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
    const decision = await readApprovalDecision(client, ownerId, run.waiting_approval_id);
    if (decision.status === 'pending')
      throw stateConflict('approval still pending', { status: 'pending' });
    if (!deps.harness) throw unavailable();
    const attemptId = randomUUID();
    const context = await contextOf(client, deps, run, attemptId, requestId, input.checkpoint_id);
    await readInvocationSnapshots(client, toolContext(context), snapshot.tool_refs);
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
      ? await readInvocationSnapshots(client, toolContext(context), snapshot.tool_refs)
      : [];
    const approval = snapshot?.waiting
      ? await readApprovalDecision(client, context.ownerId, snapshot.waiting.approval_id)
      : null;
    return { context, snapshot, observations, approval };
  });
  const { context } = initial;
  const tools = TOOLS.filter((tool) => context.allowlist.includes(tool.name));
  const start = HarnessStartSchema.parse({
    protocol: HARNESS_PROTOCOL_VERSION,
    type: 'start',
    messages: [{ message_id: context.userMessageId, role: 'user', content: context.inputText }],
    tools,
    budget: { max_iterations: context.maxIterations, max_tokens: context.maxTokens },
    snapshot: initial.snapshot,
    observations: initial.observations,
    approval: initial.approval,
  });
  let stopped = false;
  let lastSnapshot = initial.snapshot;
  const delivered = new Set(initial.snapshot?.tool_refs ?? []);
  async function guarded<T>(
    action: (client: PoolClient, locked: LockedRun) => Promise<T>,
  ): Promise<T> {
    if (stopped || signal.aborted) throw stateConflict('harness attempt stopped');
    return withTransaction(pool, async (client) => {
      const locked = await lockRun(client, context);
      return action(client, locked);
    });
  }
  async function send(event: ThreadEvent): Promise<void> {
    if (!(await write(event))) throw stateConflict('client disconnected');
  }
  async function approvalEvents(
    payload: Extract<ToolPayload, { kind: 'approval' }>,
  ): Promise<void> {
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
    if (snapshot.message_refs.length !== 1 || snapshot.message_refs[0] !== context.userMessageId)
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
    await readInvocationSnapshots(client, toolContext(context), snapshot.tool_refs);
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
    const baseline = previous ? HarnessSnapshotSchema.parse(previous.payload) : lastSnapshot;
    if (
      baseline &&
      (snapshot.next_call_no < baseline.next_call_no ||
        snapshot.usage.iterations < baseline.usage.iterations ||
        (baseline.usage.tokens !== null &&
          (snapshot.usage.tokens === null || snapshot.usage.tokens < baseline.usage.tokens)))
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
        (await readApprovalDecision(client, context.ownerId, row.approval_id)).status === 'pending'
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
  }
  return {
    start,
    handleRequest: async (request) => {
      await guarded(async () => undefined);
      if (request.type === 'model') {
        if (!deps.harness) throw unavailable();
        if (request.remaining_tokens > context.maxTokens)
          throw stateConflict('model request exceeds frozen token limit');
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
        const reply = await deps.harness.model(request, tools, signal);
        await guarded(async () => undefined);
        return reply;
      }
      if (request.type === 'reserve') {
        if (initial.approval && initial.approval.status !== 'consumed')
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
          if (request.call_key !== `harness/${accepted + 1}`)
            throw stateConflict('invalid next harness slot');
        });
        const reserved = await reserveToolInvocation(pool, toolContext(context), {
          callKey: request.call_key,
          toolId: request.tool_id,
          args: request.args,
        });
        await guarded(async () => undefined);
        return { invocation_id: reserved.invocationId };
      }
      if (request.type === 'invoke') {
        if (initial.approval && initial.approval.status !== 'consumed')
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
        const outcome = await invokeTool(pool, toolContext(context), {
          invocationId: request.invocation_id,
          toolId: request.tool_id,
          args: request.args,
        });
        await guarded(async () => undefined);
        if (
          !delivered.has(outcome.invocationId) &&
          outcome.status === 'ok' &&
          outcome.result.kind === 'approval'
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
        for (let offset = 0; offset < request.delta.length;) {
          let end = Math.min(offset + 4000, request.delta.length);
          // Public deltas are bounded in UTF-16 units; never cut a Unicode scalar.
          if (
            end < request.delta.length &&
            request.delta.charCodeAt(end - 1) >= 0xd800 &&
            request.delta.charCodeAt(end - 1) <= 0xdbff &&
            request.delta.charCodeAt(end) >= 0xdc00 &&
            request.delta.charCodeAt(end) <= 0xdfff
          )
            end -= 1;
          // Requalify each accepted output so cancellation can stop later chunks.
          const event = await guarded((client) =>
            appendEvent(client, context, 'message.delta', {
              ...eventPayload(context),
              delta: request.delta.slice(offset, end),
            }),
          );
          await send(event);
          offset = end;
        }
        return { accepted: true };
      }
      const event = await guarded(async (client) => {
        const previous = (
          await client.query<{ payload: unknown }>(
            `SELECT c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
          WHERE a.run_id=$1 AND c.kind='harness_snapshot' ORDER BY c.event_seq DESC LIMIT 1`,
            [context.runId],
          )
        ).rows[0];
        const baseline = previous ? HarnessSnapshotSchema.parse(previous.payload) : lastSnapshot;
        if (
          baseline &&
          (request.usage.iterations < baseline.usage.iterations ||
            (baseline.usage.tokens !== null &&
              (request.usage.tokens === null || request.usage.tokens < baseline.usage.tokens)) ||
            (baseline.usage.iterations > 0 &&
              baseline.usage.tokens === null &&
              request.usage.tokens !== null))
        )
          throw stateConflict('terminal usage cannot move backwards');
        if (request.outcome === 'done') {
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
              (await readApprovalDecision(client, context.ownerId, row.approval_id)).status ===
                'pending'
            )
              throw stateConflict('Run has unresolved approval');
            if (
              row.outcome_kind === 'approval_pending' &&
              !initial.snapshot?.tool_refs.includes(row.invocation_id)
            )
              throw stateConflict('approval requires explicit suspension and resume');
          }
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
