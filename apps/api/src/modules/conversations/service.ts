// Conversation entry: deterministic business use-cases or the native Harness.
// Both persist the frozen seven-event stream; native choice/loop ownership is
// exclusively in Cangjie, while TS owns accepted authority and durable facts.
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ExecutionKind } from '@along/contracts';
import type { ConversationDeps, RunContext, StartResult, EventWriter } from './contracts.js';
import {
  executeHarness,
  cancelConversationRun,
  getRunView,
  resumeConversationRun,
} from './harness-authority.js';
import { appendEvent, commitTerminal } from './run-state.js';
import { BUSINESS_TOOL_IDS, TOOL_IDS } from '../tools/contracts.js';
import { getWorkspaceGrant, validateWorkspaceGrant } from '../workspaces/service.js';
import { findReminderDirective } from '@along/time-core';
import { requireTimeContext } from '../time/context.js';
import { THREAD_PROTOCOL_VERSION, type ThreadEvent } from '@along/stream-protocol';
import { withTransaction } from '../../db/transaction.js';
import {
  forbidden,
  notFound,
  notReady,
  stateConflict,
  validationError,
  HttpError,
} from '../../http/errors.js';
import { invokeTool, reserveToolInvocation } from '../tools/gateway.js';
import type { ToolContext, ToolPayload } from '../tools/contracts.js';
import {
  ConversationEventsQuerySchema,
  SendMessageBodySchema,
  type SendMessageBody,
} from './schemas.js';
import {
  createConversation,
  deleteExpiredIdempotency,
  findIdempotency,
  freezeConversationTimezone,
  getConversation,
  getRunStatus,
  insertAttempt,
  insertIdempotency,
  insertMessage,
  insertRun,
  listConversationEvents,
  listRunEvents,
  listHarnessMessageRefs,
  lockRun,
  type ConversationRow,
} from './repository.js';
import { requireHistoryRun } from './history-repository.js';

const AGENT_REVISION = 'assistant/r1';
const BUSINESS_MAX_ITERATIONS = 10;
const BUSINESS_MAX_TOKENS = 8000;

// time-core's pure parser accepts second precision only (no milliseconds).
function utcSecondIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const CANCEL_INTENT = /取消|删掉|别再提醒/;
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function pgErrorOf(err: unknown): { code?: string; constraint?: string } | null {
  if (!err || typeof err !== 'object') return null;
  const code = 'code' in err ? err.code : undefined;
  const constraint = 'constraint' in err ? err.constraint : undefined;
  return {
    code: typeof code === 'string' ? code : undefined,
    constraint: typeof constraint === 'string' ? constraint : undefined,
  };
}

function requirePool(deps: ConversationDeps): Pool {
  if (!deps.pool) throw notReady();
  return deps.pool;
}

function requestHashOf(input: {
  conversationId: string | undefined;
  text: string;
  timezone: string | null;
  fold: string;
  execution: ExecutionKind;
  workspaceId?: string;
}): string {
  const material = [input.conversationId ?? null, input.text, input.timezone, input.fold];
  if (input.workspaceId !== undefined) material.push(input.workspaceId);
  const canonical = JSON.stringify(material);
  return createHash('sha256')
    .update(
      input.workspaceId !== undefined
        ? 'harness/workspace/v2\0'
        : input.execution === 'harness'
          ? 'harness/v1\0'
          : '',
    )
    .update(canonical, 'utf8')
    .digest('hex');
}

function textOf(body: SendMessageBody): string {
  if (!body.raw_text) throw validationError('raw_text is required');
  return body.raw_text;
}

// Runs before any SSE byte is written, so validation/idempotency failures can
// still use the JSON envelope.
export async function startConversationRun(
  deps: ConversationDeps,
  ownerId: string,
  requestId: string,
  body: unknown,
  idempotencyKeyHeader: string | null,
): Promise<StartResult> {
  const parsed = SendMessageBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid message body');
  const input = parsed.data;
  const execution = input.execution ?? 'business';
  const text = textOf(input);
  const timezone = input.confirmed_timezone_id ?? input.confirmed_timezone ?? null;
  const key = idempotencyKeyHeader ?? input.idempotency_key ?? requestId;
  const requestHash = requestHashOf({
    conversationId: input.conversation_id,
    text,
    timezone,
    fold: input.fold_choice,
    execution,
    ...(input.workspace_id !== undefined ? { workspaceId: input.workspace_id } : {}),
  });
  const pool = requirePool(deps);

  let started: {
    conversationId: string;
    runId: string;
    replayRunId: string | null;
    context: RunContext | null;
  };
  try {
    started = await withTransaction(pool, async (client: PoolClient) => {
      const existing = await findIdempotency(client, ownerId, key);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw stateConflict('idempotency key reused with a different body') as HttpError;
        }
        return {
          conversationId: existing.conversation_id,
          runId: existing.run_id,
          replayRunId: existing.run_id,
          context: null,
        };
      }
      if (execution === 'harness' && !deps.harness)
        throw new HttpError(503, 503, 'HARNESS_UNAVAILABLE', '原生 Agent 暂不可用。');
      const workspaceGrant =
        input.workspace_id !== undefined ? getWorkspaceGrant(ownerId, input.workspace_id) : null;
      const workspaceSummary = workspaceGrant
        ? validateWorkspaceGrant(ownerId, workspaceGrant)
        : null;
      const allowlist = workspaceGrant ? TOOL_IDS : BUSINESS_TOOL_IDS;

      let conversation: ConversationRow | null = null;
      if (input.conversation_id) {
        const found = await getConversation(client, input.conversation_id);
        if (!found) throw notFound('conversation not found') as HttpError;
        if (found.owner_id !== ownerId) throw forbidden('conversation not found') as HttpError;
        if (found.status !== 'open') throw stateConflict('conversation closed') as HttpError;
        conversation = found;
      }
      // Only new proposal turns need rules. Reads, cancellation and stored
      // idempotent results keep their own existing boundaries.
      if (execution === 'business' && findReminderDirective(text) >= 0 && !CANCEL_INTENT.test(text))
        requireTimeContext(deps.timeContext);
      if (!conversation) {
        const anchorIso = (await client.query<{ now: Date }>('SELECT now() AS now')).rows[0]?.now;
        if (!anchorIso) throw new Error('database clock unavailable');
        conversation = await createConversation(client, {
          ownerId,
          anchorIso: utcSecondIso(anchorIso),
          title: text.slice(0, 40),
        });
      }

      let confirmedTimezone = timezone ?? conversation.confirmed_timezone_id;
      if (!conversation.confirmed_timezone_id && timezone) {
        await freezeConversationTimezone(client, conversation.id, timezone);
        confirmedTimezone = timezone;
      }
      if (!conversation.anchor_received_at_utc) {
        throw stateConflict('conversation anchor missing') as HttpError;
      }

      const userMessageId = await insertMessage(client, {
        ownerId,
        conversationId: conversation.id,
        role: 'user',
        content: text,
        requestId,
      });
      const runId = randomUUID();
      const attemptId = randomUUID();
      const mode =
        execution === 'harness'
          ? 'chat'
          : findReminderDirective(text) >= 0 || CANCEL_INTENT.test(text)
            ? 'task'
            : 'chat';
      const receivedAtUtc = utcSecondIso(new Date());
      const maxIterations =
        execution === 'harness' ? deps.harness!.maxIterations : BUSINESS_MAX_ITERATIONS;
      const maxTokens = execution === 'harness' ? deps.harness!.maxTokens : BUSINESS_MAX_TOKENS;
      const frozenContext = {
        confirmedTimezone,
        anchorReceivedAtUtc: utcSecondIso(conversation.anchor_received_at_utc),
        receivedAtUtc,
        foldChoice: input.fold_choice,
        rulesetId: deps.timeContext.ruleset_id,
        tzdbVersion: deps.timeContext.tzdb_version,
        aliasVersion: deps.timeContext.available ? deps.timeContext.aliases.version : null,
        ...(execution === 'harness'
          ? {
              messageRefs: await listHarnessMessageRefs(client, {
                ownerId,
                conversationId: conversation.id,
                userMessageId,
              }),
            }
          : {}),
        ...(workspaceGrant ? { workspaceGrant, workspaceSummary } : {}),
      };
      await insertRun(client, {
        runId,
        ownerId,
        conversationId: conversation.id,
        agentRevision: AGENT_REVISION,
        mode,
        maxIterations,
        maxTokens,
        execution,
        allowlist,
        frozenContext,
        inputMessageId: userMessageId,
      });
      await insertAttempt(client, {
        attemptId,
        ownerId,
        runId,
        attemptNo: 1,
      });
      await deleteExpiredIdempotency(client, ownerId, key);
      await insertIdempotency(client, {
        ownerId,
        idempotencyKey: key,
        requestHash,
        conversationId: conversation.id,
        runId,
        userMessageId,
      });
      return {
        conversationId: conversation.id,
        runId,
        replayRunId: null,
        context: {
          ownerId,
          conversationId: conversation.id,
          runId,
          attemptId,
          requestId,
          inputText: text,
          confirmedTimezone,
          anchorReceivedAtUtc: utcSecondIso(conversation.anchor_received_at_utc),
          receivedAtUtc,
          foldChoice: input.fold_choice,
          maxIterations,
          maxTokens,
          execution,
          userMessageId,
          allowlist,
          ...(workspaceGrant ? { workspaceGrant } : {}),
          timeContext: deps.timeContext,
        },
      };
    });
  } catch (err) {
    const pgError = pgErrorOf(err);
    if (pgError?.code === '23505' && pgError.constraint === 'conversation_idempotency_pkey') {
      const existing = await findIdempotency(pool, ownerId, key);
      if (!existing) throw err;
      if (existing.request_hash !== requestHash) {
        throw stateConflict('idempotency key reused with a different body') as HttpError;
      }
      started = {
        conversationId: existing.conversation_id,
        runId: existing.run_id,
        replayRunId: existing.run_id,
        context: null,
      };
    } else {
      throw err;
    }
  }

  if (started.replayRunId) {
    const status = await getRunStatus(pool, ownerId, started.replayRunId);
    const replay = await listRunEvents(pool, ownerId, started.replayRunId);
    const terminal = replay.at(-1)?.type;
    const hasTerminal =
      terminal === 'thread.completed' ||
      terminal === 'thread.failed' ||
      terminal === 'thread.cancelled';
    if ((status === 'running' || status === null) && !hasTerminal) {
      throw stateConflict('run still in progress', {
        conversation_id: started.conversationId,
        run_id: started.runId,
        status: status ?? 'missing',
      }) as HttpError;
    }
    if (replay.length === 0) {
      throw stateConflict('run has no replayable events', {
        conversation_id: started.conversationId,
        run_id: started.runId,
      }) as HttpError;
    }
    return {
      conversationId: started.conversationId,
      runId: started.runId,
      replay,
      context: null,
    };
  }
  if (!started.context) throw new Error('run context missing');
  return {
    conversationId: started.conversationId,
    runId: started.runId,
    replay: null,
    context: started.context,
  };
}

interface RunSession {
  context: RunContext;
  terminal: boolean;
}

// Persist then return the envelope carrying the global event_seq. Persist
// first so a disconnect mid-stream cannot leave a gap the client never saw
// and the replay cursor remains exact.
async function persist(
  pool: Pool,
  session: RunSession,
  type: ThreadEvent['type'],
  payload: unknown,
): Promise<ThreadEvent> {
  if (session.terminal) throw stateConflict('run already terminated');
  const event = await withTransaction(pool, async (client) => {
    await lockRun(client, session.context);
    if (type === 'thread.completed' || type === 'thread.failed' || type === 'thread.cancelled') {
      return commitTerminal(
        client,
        session.context,
        type === 'thread.completed' ? 'done' : type === 'thread.failed' ? 'failed' : 'cancelled',
        payload,
      );
    }
    return appendEvent(client, session.context, type, payload);
  });
  if (type === 'thread.completed' || type === 'thread.failed' || type === 'thread.cancelled')
    session.terminal = true;
  return event;
}

async function emit(
  pool: Pool,
  session: RunSession,
  write: EventWriter,
  type: ThreadEvent['type'],
  payload: unknown,
): Promise<boolean> {
  const event = await persist(pool, session, type, payload);
  const open = await write(event);
  return open;
}

function clarifyText(payload: ToolPayload): string {
  return payload.kind === 'clarify' ? payload.text : '';
}

function toolContextOf(session: RunSession, allowlist: readonly string[]): ToolContext {
  return {
    ownerId: session.context.ownerId,
    conversationId: session.context.conversationId,
    runId: session.context.runId,
    attemptId: session.context.attemptId,
    requestId: session.context.requestId,
    allowlist,
    confirmedTimezone: session.context.confirmedTimezone,
    anchorReceivedAtUtc: session.context.anchorReceivedAtUtc,
    receivedAtUtc: session.context.receivedAtUtc,
    foldChoice: session.context.foldChoice,
    timeContext: session.context.timeContext,
  };
}

async function invokeTurnTool(pool: Pool, ctx: ToolContext, toolId: string, args: unknown) {
  // These branches are mutually exclusive: one deterministic action per v0 Run.
  const { invocationId } = await reserveToolInvocation(pool, ctx, {
    callKey: 'v0-turn/1',
    toolId,
    args,
  });
  return invokeTool(pool, ctx, { invocationId, toolId, args });
}

function startPayload(session: RunSession) {
  return {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    stream_protocol_version: THREAD_PROTOCOL_VERSION,
    ruleset_id: session.context.timeContext.ruleset_id,
    tzdb_version: session.context.timeContext.tzdb_version,
  };
}

function deltaPayload(session: RunSession, delta: string) {
  return {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    delta,
  };
}

async function failWith(
  pool: Pool,
  session: RunSession,
  write: EventWriter,
  error: { code: string; message: string; http_status: number; details?: unknown },
): Promise<void> {
  if (session.terminal) return;
  await emit(pool, session, write, 'thread.failed', {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    error,
  });
}

// Client is gone: persist the terminal event for replay, then mark the run
// cancelled. Nothing is written to the dead socket.
async function cancelRun(pool: Pool, session: RunSession): Promise<void> {
  if (session.terminal) return;
  await persist(pool, session, 'thread.cancelled', {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    reason: 'client_disconnected',
  });
}

async function completeClarify(
  pool: Pool,
  session: RunSession,
  write: EventWriter,
  text: string,
): Promise<void> {
  const ok = await emit(pool, session, write, 'message.delta', deltaPayload(session, text));
  if (!ok) {
    await cancelRun(pool, session);
    return;
  }
  await emit(pool, session, write, 'thread.completed', {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    approval_id: null,
  });
}

async function completeApproval(
  pool: Pool,
  session: RunSession,
  write: EventWriter,
  payload: Extract<ToolPayload, { kind: 'approval' }>,
): Promise<void> {
  const okDelta = await emit(
    pool,
    session,
    write,
    'message.delta',
    deltaPayload(session, payload.echo_text),
  );
  if (!okDelta) {
    await cancelRun(pool, session);
    return;
  }
  const okCard = await emit(pool, session, write, 'card.proposed', {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    card_id: payload.card_id,
    schema_version: 'v1',
    wall_time: payload.approval.wallTime,
    timezone_id: payload.approval.timezoneId,
    original_text: payload.original_text,
  });
  if (!okCard) {
    await cancelRun(pool, session);
    return;
  }
  const okApproval = await emit(pool, session, write, 'approval_required', {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    approval_id: payload.approval.approvalId,
    card_id: payload.card_id,
    presentation_hash: payload.approval.presentationHash,
  });
  if (!okApproval) {
    await cancelRun(pool, session);
    return;
  }
  await emit(pool, session, write, 'thread.completed', {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    approval_id: payload.approval.approvalId,
  });
}

function listSummary(payload: Extract<ToolPayload, { kind: 'list_tasks' }>): string {
  if (payload.tasks.length === 0) return '现在没有进行中的提醒。';
  const lines = payload.tasks.map(
    (task) =>
      `- ${task.note_preview || '(无备注)'}：${task.fire_at_local_text}（${task.timezone_id}，${task.state}）`,
  );
  const suffix = payload.has_more ? '\n还有更多，请在任务列表查看。' : '';
  return `你有 ${payload.tasks.length} 条进行中的提醒：\n${lines.join('\n')}${suffix}`;
}

function briefSummary(payload: Extract<ToolPayload, { kind: 'brief' }>): string {
  if (payload.cards.length === 0) return `${payload.date} 没有可展示的卡片。`;
  return `${payload.date} 有 ${payload.cards.length} 张卡片：\n${payload.cards
    .map((card) => `- ${card.title || '(无标题)'}：${card.body_text}`)
    .join('\n')}`;
}

async function executeBusinessTurn(
  pool: Pool,
  session: RunSession,
  write: EventWriter,
): Promise<void> {
  const open = await emit(pool, session, write, 'thread.started', startPayload(session));
  if (!open) {
    await cancelRun(pool, session);
    return;
  }

  const text = session.context.inputText;
  const wantsReminder = findReminderDirective(text) >= 0;
  const wantsCancel = CANCEL_INTENT.test(text);

  if (wantsReminder && wantsCancel) {
    await completeClarify(
      pool,
      session,
      write,
      '一次只说一件事：请先告诉我是新建提醒，还是取消某条提醒。',
    );
    return;
  }

  if (wantsCancel) {
    const taskId = UUID_IN_TEXT.exec(text)?.[0];
    if (!taskId) {
      await completeClarify(
        pool,
        session,
        write,
        '请给要取消的任务 id（可在任务列表看到），我才能生成取消确认。',
      );
      return;
    }
    const outcome = await invokeTurnTool(
      pool,
      toolContextOf(session, ['request_cancel_task', 'list_tasks']),
      'request_cancel_task',
      { task_id: taskId, reason_text: text },
    );
    if (outcome.status === 'failed' || outcome.status === 'unknown') {
      await failWith(pool, session, write, {
        ...outcome.error,
        http_status: outcome.status === 'unknown' ? 409 : 500,
      });
      return;
    }
    if (outcome.status === 'denied') {
      await completeClarify(pool, session, write, '没有权限取消该任务；请确认任务 id。');
      return;
    }
    if (outcome.result.kind === 'approval') {
      await completeApproval(pool, session, write, outcome.result);
      return;
    }
    await completeClarify(pool, session, write, clarifyText(outcome.result));
    return;
  }

  if (wantsReminder) {
    const outcome = await invokeTurnTool(
      pool,
      toolContextOf(session, ['propose_task', 'list_tasks', 'get_user_prefs']),
      'propose_task',
      {
        raw_time_text: text,
        timezone_hint: session.context.confirmedTimezone,
        note: text,
        occurrence: 'once',
      },
    );
    if (outcome.status === 'failed' || outcome.status === 'unknown') {
      await failWith(pool, session, write, {
        ...outcome.error,
        http_status: outcome.status === 'unknown' ? 409 : 500,
      });
      return;
    }
    if (outcome.status === 'denied') {
      await completeClarify(pool, session, write, '这条提醒没能处理；请重述日期、时间和时区。');
      return;
    }
    if (outcome.result.kind === 'approval') {
      await completeApproval(pool, session, write, outcome.result);
      return;
    }
    if (outcome.result.kind === 'time_error') {
      await failWith(pool, session, write, outcome.result.error);
      return;
    }
    await completeClarify(pool, session, write, clarifyText(outcome.result));
    return;
  }

  // Default deterministic business lookup; never a native/provider fallback.
  const outcome = await invokeTurnTool(
    pool,
    toolContextOf(session, ['list_tasks', 'read_brief_cards', 'get_user_prefs']),
    'list_tasks',
    { limit: 5 },
  );
  if (outcome.status === 'failed' || outcome.status === 'unknown') {
    await failWith(pool, session, write, {
      ...outcome.error,
      http_status: outcome.status === 'unknown' ? 409 : 500,
    });
    return;
  }
  if (outcome.status === 'ok' && outcome.result.kind === 'list_tasks') {
    await completeClarify(pool, session, write, listSummary(outcome.result));
    return;
  }
  if (outcome.status === 'ok' && outcome.result.kind === 'brief') {
    await completeClarify(pool, session, write, briefSummary(outcome.result));
    return;
  }
  await completeClarify(
    pool,
    session,
    write,
    '请给明确的日期、时间和时区，例如：明天 9:20 提醒我喝水。',
  );
}

export async function executeRun(
  deps: ConversationDeps,
  context: RunContext,
  write: EventWriter,
  signal?: AbortSignal,
): Promise<void> {
  const pool = requirePool(deps);
  const execution = await withTransaction(
    pool,
    async (client) => (await lockRun(client, context, true, false)).run.execution,
  );
  if (execution === 'harness') {
    await executeHarness(deps, context, write, signal);
    return;
  }
  const session: RunSession = {
    context,
    terminal: false,
  };
  try {
    await executeBusinessTurn(pool, session, write);
  } catch {
    if (session.terminal) return;
    // Post-open failures must still end the stream; if even the terminal
    // checkpoint cannot be written, close without corrupting the JSON path.
    try {
      await failWith(pool, session, write, {
        code: 'INTERNAL_ERROR',
        message: '内部错误，请稍后重试。',
        http_status: 500,
      });
    } catch {
      if (session.terminal) return;
    }
  }
}

export interface ConversationDetail {
  conversation_id: string;
  status: string;
  confirmed_timezone_id: string | null;
  anchor_received_at_utc: string | null;
  events: ThreadEvent[];
  next_after_seq: number | null;
}

export async function getConversationDetail(
  deps: ConversationDeps,
  ownerId: string,
  conversationId: string,
  query: Record<string, string | string[] | undefined>,
): Promise<ConversationDetail> {
  const pool = requirePool(deps);
  const parsed = ConversationEventsQuerySchema.safeParse(query);
  if (!parsed.success) throw validationError('invalid events query');
  const conversation = await getConversation(pool, conversationId);
  if (!conversation) throw notFound('conversation not found');
  if (conversation.owner_id !== ownerId) throw forbidden('conversation not found');
  if (
    parsed.data.run_id &&
    !(await requireHistoryRun(pool, ownerId, conversationId, parsed.data.run_id))
  ) {
    throw notFound('Run not found');
  }
  const events = await listConversationEvents(pool, {
    ownerId,
    conversationId,
    afterSeq: parsed.data.after_seq ?? null,
    limit: parsed.data.limit,
    runId: parsed.data.run_id,
  });
  const last = events.at(-1);
  return {
    conversation_id: conversation.id,
    status: conversation.status,
    confirmed_timezone_id: conversation.confirmed_timezone_id,
    anchor_received_at_utc: conversation.anchor_received_at_utc?.toISOString() ?? null,
    events,
    next_after_seq: last ? last.seq : null,
  };
}

export { cancelConversationRun, getRunView, resumeConversationRun };
