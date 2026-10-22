// ToolGateway (issue #9): the only path from the assistant tool-loop to tool
// implementations. docs/agent/02: allowlist -> strict zod -> risk gate ->
// execute (read-only, or approval-only for high risk) -> audit row.
// It never creates/updates tasks; high-risk tools only insert approvals.
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { TimeContext } from '../time/context.js';
import { normalizeTime, type TimeFailure } from '../time/normalize.js';
import {
  createCancelTaskApproval,
  createTaskApproval,
  type CreatedApproval,
} from '../approvals/create.js';
import {
  renderEchoCancelV1,
  renderCreateTaskEcho,
  shortNoOf,
  type PresentationSnapshot,
} from '../approvals/presentation.js';
import { TOOL_INPUT_SCHEMAS, TOOL_IDS, type ToolId } from './schemas.js';

export interface ToolContext {
  ownerId: string;
  conversationId: string;
  runId: string;
  attemptId: string | null;
  requestId: string;
  allowlist: readonly string[];
  confirmedTimezone: string | null;
  anchorReceivedAtUtc: string;
  receivedAtUtc: string;
  foldChoice: 'first' | 'second' | 'none';
  timeContext: TimeContext;
}

export interface ApprovalPayload {
  kind: 'approval';
  approval: CreatedApproval;
  echo_text: string;
  card_id: string;
  original_text: string;
}

export interface ClarifyPayload {
  kind: 'clarify';
  reason: string;
  phrase_key: string;
  text: string;
}

export interface TimeErrorPayload {
  kind: 'time_error';
  error: TimeFailure;
}

export interface ListTasksPayload {
  kind: 'list_tasks';
  tasks: {
    task_id: string;
    note_preview: string;
    fire_at_local_text: string;
    timezone_id: string;
    state: string;
  }[];
  has_more: boolean;
}

export interface BriefPayload {
  kind: 'brief';
  brief_id: string;
  date: string;
  cards: {
    card_id: string;
    kind: string;
    title: string;
    body_text: string;
    source_refs: string[];
    presentation_version: string;
  }[];
}

export interface PrefsPayload {
  kind: 'prefs';
  timezone_id: string | null;
  alias_version: string;
  quiet_hours: null;
  locale: null;
}

export type ToolPayload =
  | ApprovalPayload
  | ClarifyPayload
  | TimeErrorPayload
  | ListTasksPayload
  | BriefPayload
  | PrefsPayload;

export type ToolOutcome =
  | { status: 'ok'; result: ToolPayload }
  | { status: 'denied'; error: { code: string; message: string } };

const CLARIFY_TEXT: Record<string, string> = {
  ASK_YEAR: '请给年份：日期需要年份才能排期，请补充年份（如 2026 年 10 月 17 日 09:20）。',
  ASK_TIMEZONE: '请给时区：按哪个时区排？（如 Asia/Shanghai；本次确认只用于本次）',
  ASK_TIMEZONE_ALIAS: '这个时区别名认不出来；请给规范 IANA 时区，如 Asia/Shanghai。',
  ASK_DAYPART: '请明确是上午 09:00 还是晚上 21:00？（差半天，不能替选）',
  ASK_DATE_RECONFIRM: '跨天了，请重新给具体日期。',
  ASK_FOLD: '结构化选择与原文冲突，请明确第一次或第二次并重新选择。',
  RANGE_UNSUPPORTED: '范围无法唯一排触发点，请给准确时刻；v0 不支持范围提醒。',
  NO_CALENDAR: 'v0 不读日历不监测空闲，这次不保存；请给明确日期时间时区。',
  ASK_EXACT_TIME: '请给准确的日期和时间；v0 不支持“尽快/晚点”。',
};

// Deterministic canonical form for args_hash: sorted object keys, arrays in
// order. Only the hash is stored (tool_calls never keeps raw args).
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

async function recordInvocation(
  pool: Pool,
  ctx: ToolContext,
  toolId: string,
  argsHash: string,
  decision: 'allow' | 'deny',
  approvalId: string | null,
  errorCode: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO tool_calls (id, owner_id, run_id, attempt_id, tool_id,
       args_hash, decision, approval_id, error_code)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (run_id, tool_id, args_hash) DO NOTHING`,
    [ctx.ownerId, ctx.runId, ctx.attemptId, toolId, argsHash, decision, approvalId, errorCode],
  );
}

function approvalSnapshot(input: {
  originalText: string;
  wallTime: string;
  timezoneId: string;
  fold: 0 | 1;
  offsetSeconds: number;
  presentationVersion: string;
}): PresentationSnapshot {
  return {
    originalText: input.originalText,
    localDatetime: input.wallTime,
    timezoneId: input.timezoneId,
    fold: input.fold,
    offsetSeconds: input.offsetSeconds,
    occurrence: 'single',
    presentationVersion: input.presentationVersion,
  };
}

async function runProposeTask(
  pool: Pool,
  ctx: ToolContext,
  args: unknown,
): Promise<{ payload: ToolPayload; approvalId: string | null; errorCode: string | null }> {
  const parsed = TOOL_INPUT_SCHEMAS.propose_task.safeParse(args);
  if (!parsed.success) {
    return {
      payload: {
        kind: 'clarify',
        reason: 'INVALID_ARGS',
        phrase_key: 'INVALID_ARGS',
        text: '工具参数不合法，已拒绝；请重述提醒内容与时间。',
      },
      approvalId: null,
      errorCode: 'TOOL_FORBIDDEN',
    };
  }
  const input = parsed.data;
  const result = normalizeTime(ctx.timeContext, {
    raw_text: input.raw_time_text,
    anchorReceivedAtUtc: ctx.anchorReceivedAtUtc,
    confirmedTimezone: input.timezone_hint ?? ctx.confirmedTimezone,
    receivedAtUtc: ctx.receivedAtUtc,
    foldChoice: ctx.foldChoice,
  });
  if (result.kind === 'error') {
    return {
      payload: { kind: 'time_error', error: result.error },
      approvalId: null,
      errorCode: result.error.code,
    };
  }
  if (result.kind === 'clarify') {
    const classified = result.classified;
    const phrase = classified.phrase_key ?? 'ASK_EXACT_TIME';
    return {
      payload: {
        kind: 'clarify',
        reason: classified.reason ?? 'UNCLASSIFIED',
        phrase_key: phrase,
        text: CLARIFY_TEXT[phrase] ?? CLARIFY_TEXT.ASK_EXACT_TIME,
      },
      approvalId: null,
      errorCode: null,
    };
  }
  const normalized = result.normalized;
  const wallTime = `${result.wall_time.slice(0, 10)} ${result.wall_time.slice(11, 16)}`;
  const fold: 0 | 1 = normalized.fold;
  const approval = await createTaskApproval(pool, {
    ownerId: ctx.ownerId,
    conversationId: ctx.conversationId,
    originalText: input.note,
    wallTime,
    timezoneId: result.timezone_id,
    fold,
    foldChoice: ctx.foldChoice,
    offsetSeconds: normalized.offset_seconds,
    fireAtUtc: normalized.fire_at_utc,
    tzdbVersion: result.tzdb_version,
  });
  const snapshot = approvalSnapshot({
    originalText: approval.originalText,
    wallTime: approval.wallTime,
    timezoneId: approval.timezoneId,
    fold: approval.fold,
    offsetSeconds: approval.offsetSeconds,
    presentationVersion: approval.presentationVersion,
  });
  const echo = renderCreateTaskEcho(snapshot, shortNoOf(approval.approvalId));
  return {
    payload: {
      kind: 'approval',
      approval,
      echo_text: echo,
      card_id: `card:${approval.approvalId}`,
      original_text: approval.originalText,
    },
    approvalId: approval.approvalId,
    errorCode: null,
  };
}

async function runRequestCancelTask(
  pool: Pool,
  ctx: ToolContext,
  args: unknown,
): Promise<{ payload: ToolPayload; approvalId: string | null; errorCode: string | null }> {
  const parsed = TOOL_INPUT_SCHEMAS.request_cancel_task.safeParse(args);
  if (!parsed.success) {
    return {
      payload: {
        kind: 'clarify',
        reason: 'INVALID_ARGS',
        phrase_key: 'INVALID_ARGS',
        text: '工具参数不合法，已拒绝；请给出要取消的任务 id。',
      },
      approvalId: null,
      errorCode: 'TOOL_FORBIDDEN',
    };
  }
  const input = parsed.data;
  const { rows } = await pool.query<{
    id: string;
    owner_id: string;
    state: string;
    state_version: number;
    wall_time: string;
    timezone_id: string;
    fold: number;
    resolved_utc_offset_seconds: number;
    tzdb_version: string;
    fire_at_utc: Date;
    original_note: string | null;
  }>(
    `SELECT id, owner_id, state, state_version, wall_time, timezone_id, fold,
       resolved_utc_offset_seconds, tzdb_version, fire_at_utc, original_note
     FROM tasks WHERE id = $1`,
    [input.task_id],
  );
  const task = rows[0];
  if (!task || task.owner_id !== ctx.ownerId) {
    return {
      payload: {
        kind: 'clarify',
        reason: 'TOOL_FORBIDDEN',
        phrase_key: 'TOOL_FORBIDDEN',
        text: '没有找到可取消的任务；请确认任务 id。',
      },
      approvalId: null,
      errorCode: 'TOOL_FORBIDDEN',
    };
  }
  if (task.state === 'fired' || task.state === 'missed' || task.state === 'cancelled') {
    return {
      payload: {
        kind: 'clarify',
        reason: 'STATE_CONFLICT',
        phrase_key: 'STATE_CONFLICT',
        text: '这条提醒已经结束或已取消，不需要再取消。',
      },
      approvalId: null,
      errorCode: 'STATE_CONFLICT',
    };
  }
  const originalText = input.reason_text ?? task.original_note ?? '取消提醒';
  const fold: 0 | 1 = task.fold === 1 ? 1 : 0;
  const approval = await createCancelTaskApproval(pool, {
    ownerId: ctx.ownerId,
    conversationId: ctx.conversationId,
    originalText,
    targetTaskId: task.id,
    expectedStateVersion: task.state_version,
    wallTime: task.wall_time,
    timezoneId: task.timezone_id,
    fold,
    offsetSeconds: task.resolved_utc_offset_seconds,
    fireAtUtc: task.fire_at_utc.toISOString(),
    tzdbVersion: task.tzdb_version,
  });
  const echo = renderEchoCancelV1(
    approvalSnapshot({
      originalText: approval.originalText,
      wallTime: approval.wallTime,
      timezoneId: approval.timezoneId,
      fold: approval.fold,
      offsetSeconds: approval.offsetSeconds,
      presentationVersion: approval.presentationVersion,
    }),
    shortNoOf(approval.approvalId),
  );
  return {
    payload: {
      kind: 'approval',
      approval,
      echo_text: echo,
      card_id: `card:${approval.approvalId}`,
      original_text: approval.originalText,
    },
    approvalId: approval.approvalId,
    errorCode: null,
  };
}

const ACTIVE_STATES = ['saved', 'pending_schedule', 'scheduled', 'cancel_pending'] as const;

async function runListTasks(
  pool: Pool,
  ctx: ToolContext,
  args: unknown,
): Promise<{ payload: ToolPayload; approvalId: null; errorCode: null }> {
  const parsed = TOOL_INPUT_SCHEMAS.list_tasks.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      payload: {
        kind: 'clarify',
        reason: 'INVALID_ARGS',
        phrase_key: 'INVALID_ARGS',
        text: '工具参数不合法，已拒绝。',
      },
      approvalId: null,
      errorCode: null,
    };
  }
  const input = parsed.data;
  const states = input.state ? [input.state] : [...ACTIVE_STATES];
  const { rows } = await pool.query<{
    id: string;
    original_note: string | null;
    wall_time: string;
    timezone_id: string;
    state: string;
  }>(
    `SELECT id, original_note, wall_time, timezone_id, state FROM tasks
     WHERE owner_id = $1 AND state = ANY($2::text[])
     ORDER BY fire_at_utc ASC LIMIT $3`,
    [ctx.ownerId, states, input.limit + 1],
  );
  const hasMore = rows.length > input.limit;
  return {
    payload: {
      kind: 'list_tasks',
      tasks: rows.slice(0, input.limit).map((row) => ({
        task_id: row.id,
        note_preview: (row.original_note ?? '').slice(0, 30),
        fire_at_local_text: row.wall_time,
        timezone_id: row.timezone_id,
        state: row.state,
      })),
      has_more: hasMore,
    },
    approvalId: null,
    errorCode: null,
  };
}

async function runReadBriefCards(
  pool: Pool,
  ctx: ToolContext,
  args: unknown,
): Promise<{ payload: ToolPayload; approvalId: null; errorCode: null }> {
  const parsed = TOOL_INPUT_SCHEMAS.read_brief_cards.safeParse(args);
  if (!parsed.success) {
    return {
      payload: {
        kind: 'clarify',
        reason: 'INVALID_ARGS',
        phrase_key: 'INVALID_ARGS',
        text: '日期格式不合法；请给 YYYY-MM-DD。',
      },
      approvalId: null,
      errorCode: null,
    };
  }
  const input = parsed.data;
  const { rows } = await pool.query<{
    id: string;
    original_note: string | null;
    wall_time: string;
    timezone_id: string;
    state: string;
  }>(
    `SELECT id, original_note, wall_time, timezone_id, state FROM tasks
     WHERE owner_id = $1 AND wall_time LIKE $2 || '%' AND state <> 'cancelled'
       AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
     ORDER BY wall_time ASC LIMIT 50`,
    [ctx.ownerId, input.date, input.card_ids ?? null],
  );
  return {
    payload: {
      kind: 'brief',
      brief_id: `brief:${input.date}`,
      date: input.date,
      cards: rows.map((row) => ({
        card_id: row.id,
        kind: 'task',
        title: (row.original_note ?? '').slice(0, 30),
        body_text: `${row.wall_time}（${row.timezone_id}）`,
        source_refs: [row.id],
        presentation_version: 'v1',
      })),
    },
    approvalId: null,
    errorCode: null,
  };
}

async function runGetUserPrefs(
  pool: Pool,
  ctx: ToolContext,
): Promise<{ payload: ToolPayload; approvalId: null; errorCode: null }> {
  const { rows } = await pool.query<{ timezone_id: string | null }>(
    'SELECT timezone_id FROM users WHERE id = $1',
    [ctx.ownerId],
  );
  return {
    payload: {
      kind: 'prefs',
      timezone_id: rows[0]?.timezone_id ?? null,
      alias_version: ctx.timeContext.available ? ctx.timeContext.aliases.version : 'unavailable',
      quiet_hours: null,
      locale: null,
    },
    approvalId: null,
    errorCode: null,
  };
}

// Gateway entry point: every assistant tool call goes through here.
export async function invokeTool(
  pool: Pool,
  ctx: ToolContext,
  toolId: string,
  args: unknown,
): Promise<ToolOutcome> {
  const known = (TOOL_IDS as readonly string[]).includes(toolId);
  if (!known) {
    await recordInvocation(pool, ctx, toolId, 'unknown', 'deny', null, 'TOOL_FORBIDDEN');
    return { status: 'denied', error: { code: 'TOOL_FORBIDDEN', message: 'unknown tool' } };
  }
  if (!ctx.allowlist.includes(toolId)) {
    const argsHash = createHash('sha256')
      .update(stableStringify(args ?? null))
      .digest('hex');
    await recordInvocation(pool, ctx, toolId, argsHash, 'deny', null, 'TOOL_DENIED');
    return { status: 'denied', error: { code: 'TOOL_DENIED', message: 'tool not in allowlist' } };
  }
  const argsHash = createHash('sha256')
    .update(stableStringify(args ?? null))
    .digest('hex');

  let executed: { payload: ToolPayload; approvalId: string | null; errorCode: string | null };
  try {
    switch (toolId as ToolId) {
      case 'propose_task':
        executed = await runProposeTask(pool, ctx, args);
        break;
      case 'request_cancel_task':
        executed = await runRequestCancelTask(pool, ctx, args);
        break;
      case 'list_tasks':
        executed = await runListTasks(pool, ctx, args);
        break;
      case 'read_brief_cards':
        executed = await runReadBriefCards(pool, ctx, args);
        break;
      case 'get_user_prefs':
        executed = await runGetUserPrefs(pool, ctx);
        break;
    }
  } catch (err) {
    await recordInvocation(pool, ctx, toolId, argsHash, 'allow', null, 'TOOL_ERROR');
    throw err;
  }

  const denied = executed.errorCode === 'TOOL_FORBIDDEN';
  await recordInvocation(
    pool,
    ctx,
    toolId,
    argsHash,
    denied ? 'deny' : 'allow',
    executed.approvalId,
    executed.errorCode,
  );
  if (denied) {
    return {
      status: 'denied',
      error: { code: 'TOOL_FORBIDDEN', message: 'tool invocation rejected' },
    };
  }
  return { status: 'ok', result: executed.payload };
}
