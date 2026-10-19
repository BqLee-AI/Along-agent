// Conversation runtime (issue #9): POST /conversations/messages orchestration.
// Deterministic v0 (no LLM provider): triage -> ToolGateway -> approval or
// clarification; every SSE event is persisted to run_checkpoints first so
// replay (idempotent POST and GET after_seq) is exact.
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { FIXTURE_V1 } from '@along/time-core';
import {
  THREAD_PROTOCOL_VERSION,
  ThreadEventSchema,
  type ThreadEvent,
} from '@along/stream-protocol';
import { withTransaction } from '../../db/transaction.js';
import {
  forbidden,
  notFound,
  notReady,
  stateConflict,
  validationError,
  type HttpError,
} from '../../http/errors.js';
import { invokeTool, type ToolContext, type ToolPayload } from '../tools/gateway.js';
import {
  ConversationEventsQuerySchema,
  SendMessageBodySchema,
  type SendMessageBody,
} from './schemas.js';
import {
  appendCheckpoint,
  createConversation,
  deleteExpiredIdempotency,
  findIdempotency,
  finishAttempt,
  finishRun,
  freezeConversationTimezone,
  getConversation,
  getRunStatus,
  insertAttempt,
  insertIdempotency,
  insertMessage,
  insertRun,
  listConversationEvents,
  listRunEvents,
  type ConversationRow,
} from './repository.js';

const AGENT_REVISION = 'assistant/r1';
const MAX_ITERATIONS = 10;
const MAX_TOKENS = 8000;
// Conservative token estimate: one code point per token (CJK-heavy text).
// v0 has no provider callback, so TS owns the count.
const estimateTokens = (text: string): number => [...text].length;

// time-core's pure parser accepts second precision only (no milliseconds).
function utcSecondIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const REMINDER_INTENT = /提醒|叫我|通知我|记得|别忘了/;
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

export interface ConversationDeps {
  pool: Pool | null;
}

export interface RunContext {
  ownerId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  requestId: string;
  inputText: string;
  confirmedTimezone: string | null;
  anchorReceivedAtUtc: string;
  receivedAtUtc: string;
  foldChoice: 'first' | 'second' | 'none';
  maxIterations: number;
  maxTokens: number;
}

export interface StartResult {
  conversationId: string;
  runId: string;
  replay: ThreadEvent[] | null;
  context: RunContext | null;
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
}): string {
  const canonical = JSON.stringify([
    input.conversationId ?? null,
    input.text,
    input.timezone,
    input.fold,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
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
  const text = textOf(input);
  const timezone = input.confirmed_timezone_id ?? input.confirmed_timezone ?? null;
  const key = idempotencyKeyHeader ?? input.idempotency_key ?? requestId;
  const requestHash = requestHashOf({
    conversationId: input.conversation_id,
    text,
    timezone,
    fold: input.fold_choice,
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

      let conversation: ConversationRow;
      if (input.conversation_id) {
        const found = await getConversation(client, input.conversation_id);
        if (!found) throw notFound('conversation not found') as HttpError;
        if (found.owner_id !== ownerId) {
          throw forbidden('conversation not found') as HttpError;
        }
        if (found.status !== 'open') {
          throw stateConflict('conversation closed') as HttpError;
        }
        conversation = found;
      } else {
        const anchorIso = (await client.query<{ now: Date }>('SELECT now() AS now')).rows[0]?.now;
        if (!anchorIso) throw new Error('database clock unavailable');
        conversation = await createConversation(client, {
          ownerId,
          anchorIso: utcSecondIso(anchorIso),
          title: text.slice(0, 40),
        });
      }

      let confirmedTimezone = conversation.confirmed_timezone_id;
      if (!confirmedTimezone && timezone) {
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
      const mode = REMINDER_INTENT.test(text) || CANCEL_INTENT.test(text) ? 'task' : 'chat';
      await insertRun(client, {
        runId,
        ownerId,
        conversationId: conversation.id,
        agentRevision: AGENT_REVISION,
        mode,
        maxIterations: MAX_ITERATIONS,
        maxTokens: MAX_TOKENS,
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
      const receivedAtUtc = utcSecondIso(new Date());
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
          maxIterations: MAX_ITERATIONS,
          maxTokens: MAX_TOKENS,
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
    if (status === 'running' || status === null) {
      throw stateConflict('run still in progress', {
        conversation_id: started.conversationId,
        run_id: started.runId,
        status: status ?? 'missing',
      }) as HttpError;
    }
    const replay = await listRunEvents(pool, ownerId, started.replayRunId);
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

export type EventWriter = (event: ThreadEvent) => Promise<boolean>;

interface RunSession {
  context: RunContext;
  seq: number;
  tokens: number;
  iterations: number;
  assistantText: string;
  stopped: boolean;
}

function envelopeOf(
  session: RunSession,
  eventSeq: number,
  type: ThreadEvent['type'],
  payload: unknown,
): ThreadEvent {
  return ThreadEventSchema.parse({
    protocol_version: THREAD_PROTOCOL_VERSION,
    seq: eventSeq,
    type,
    payload,
    request_id: session.context.requestId,
  });
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
  const eventSeq = await appendCheckpoint(pool, {
    ownerId: session.context.ownerId,
    attemptId: session.context.attemptId,
    seq: session.seq,
    type,
    payload,
    requestId: session.context.requestId,
  });
  session.seq += 1;
  return envelopeOf(session, eventSeq, type, payload);
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
  if (!open) session.stopped = true;
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
  };
}

function startPayload(session: RunSession) {
  return {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    stream_protocol_version: THREAD_PROTOCOL_VERSION,
    ruleset_id: FIXTURE_V1.ruleset_id,
    tzdb_version: FIXTURE_V1.tzdb_version,
  };
}

function deltaPayload(session: RunSession, delta: string) {
  return {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    delta,
  };
}

async function finish(
  pool: Pool,
  session: RunSession,
  status: 'done' | 'failed' | 'cancelled',
): Promise<void> {
  // Message first: if this fails the run stays running so the caller can
  // still emit thread.failed instead of a completed-then-failed double end.
  if (session.assistantText.length > 0) {
    await insertMessage(pool, {
      ownerId: session.context.ownerId,
      conversationId: session.context.conversationId,
      role: 'assistant',
      content: session.assistantText,
      requestId: null,
    });
  }
  await finishAttempt(pool, session.context.attemptId, status === 'done' ? 'done' : 'failed');
  await finishRun(pool, session.context.runId, status);
}

async function failWith(
  pool: Pool,
  session: RunSession,
  write: EventWriter,
  error: { code: string; message: string; http_status: number; details?: unknown },
): Promise<void> {
  if (session.assistantText.length === 0) session.assistantText = error.message;
  await emit(pool, session, write, 'thread.failed', {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    error,
  });
  await finish(pool, session, 'failed');
}

// Client is gone: persist the terminal event for replay, then mark the run
// cancelled. Nothing is written to the dead socket.
async function cancelRun(pool: Pool, session: RunSession): Promise<void> {
  await persist(pool, session, 'thread.cancelled', {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    reason: 'client_disconnected',
  });
  await finish(pool, session, 'cancelled');
}

async function completeClarify(
  pool: Pool,
  session: RunSession,
  write: EventWriter,
  text: string,
): Promise<void> {
  const ok = await emit(pool, session, write, 'message.delta', deltaPayload(session, text));
  session.assistantText += text;
  if (!ok) {
    await cancelRun(pool, session);
    return;
  }
  const completed = await emit(pool, session, write, 'thread.completed', {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    approval_id: null,
  });
  if (!completed) {
    await cancelRun(pool, session);
    return;
  }
  await finish(pool, session, 'done');
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
  session.assistantText += payload.echo_text;
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
  const completed = await emit(pool, session, write, 'thread.completed', {
    conversation_id: session.context.conversationId,
    run_id: session.context.runId,
    approval_id: payload.approval.approvalId,
  });
  if (!completed) {
    await cancelRun(pool, session);
    return;
  }
  await finish(pool, session, 'done');
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

async function runTurn(pool: Pool, session: RunSession, write: EventWriter): Promise<void> {
  const open = await emit(pool, session, write, 'thread.started', startPayload(session));
  if (!open) {
    await cancelRun(pool, session);
    return;
  }

  if (session.tokens > session.context.maxTokens) {
    await failWith(pool, session, write, {
      code: 'BUDGET_EXCEEDED',
      message: '本轮推理预算用完，已停下；请换句更具体的话重说。',
      http_status: 429,
      details: { max_tokens: session.context.maxTokens, tokens: session.tokens },
    });
    return;
  }

  const text = session.context.inputText;
  const wantsReminder = REMINDER_INTENT.test(text);
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
    session.iterations += 1;
    if (session.iterations > session.context.maxIterations) {
      await failWith(pool, session, write, {
        code: 'BUDGET_EXCEEDED',
        message: '本轮推理预算用完，已停下；请换句更具体的话重说。',
        http_status: 429,
        details: { max_iterations: session.context.maxIterations },
      });
      return;
    }
    const outcome = await invokeTool(
      pool,
      toolContextOf(session, ['request_cancel_task', 'list_tasks']),
      'request_cancel_task',
      { task_id: taskId, reason_text: text },
    );
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
    session.iterations += 1;
    if (session.iterations > session.context.maxIterations) {
      await failWith(pool, session, write, {
        code: 'BUDGET_EXCEEDED',
        message: '本轮推理预算用完，已停下；请换句更具体的话重说。',
        http_status: 429,
        details: { max_iterations: session.context.maxIterations },
      });
      return;
    }
    const outcome = await invokeTool(
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
    if (outcome.status === 'denied') {
      await completeClarify(pool, session, write, '这条提醒没能处理；请重述日期、时间和时区。');
      return;
    }
    if (outcome.result.kind === 'approval') {
      await completeApproval(pool, session, write, outcome.result);
      return;
    }
    await completeClarify(pool, session, write, clarifyText(outcome.result));
    return;
  }

  // Agent route: read-only lookup, never an approval.
  session.iterations += 1;
  const outcome = await invokeTool(
    pool,
    toolContextOf(session, ['list_tasks', 'read_brief_cards', 'get_user_prefs']),
    'list_tasks',
    { limit: 5 },
  );
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
): Promise<void> {
  const pool = requirePool(deps);
  const session: RunSession = {
    context,
    seq: 1,
    tokens: estimateTokens(context.inputText),
    iterations: 0,
    assistantText: '',
    stopped: false,
  };
  try {
    await runTurn(pool, session, write);
  } catch {
    // Post-open failures must still end the stream; if even the terminal
    // checkpoint cannot be written, close without corrupting the JSON path.
    try {
      await failWith(pool, session, write, {
        code: 'INTERNAL_ERROR',
        message: '内部错误，请稍后重试。',
        http_status: 500,
      });
    } catch {
      try {
        await finish(pool, session, 'failed');
      } catch {
        // socket/DB gone: nothing left to persist
      }
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
  const parsed = ConversationEventsQuerySchema.safeParse({
    after_seq: typeof query.after_seq === 'string' ? query.after_seq : undefined,
    limit: typeof query.limit === 'string' ? query.limit : undefined,
  });
  if (!parsed.success) throw validationError('invalid events query');
  const conversation = await getConversation(pool, conversationId);
  if (!conversation) throw notFound('conversation not found');
  if (conversation.owner_id !== ownerId) throw forbidden('conversation not found');
  const events = await listConversationEvents(pool, {
    ownerId,
    conversationId,
    afterSeq: parsed.data.after_seq ?? null,
    limit: parsed.data.limit,
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
