import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ConversationDeps, RunContext, EventWriter } from '../execution/contracts.js';
import {
  CANCEL_INTENT,
  requirePool,
  appendEvent,
  lockRun,
  writeAuthorizedEvent,
} from '../../features/conversations/public.js';
import { executeAttempt } from '../execution/attempt/execute.js';
import { cancelConversationRun } from './run-actions.js';
import { commitTerminal } from '../execution/result/commit.js';
import { findReminderDirective } from '@along/time-core';
import { THREAD_PROTOCOL_VERSION, type ThreadEvent } from '@along/stream-protocol';
import { withTransaction } from '../../db/transaction.js';
import { stateConflict } from '../../platform/errors.js';
import { invokeTool, reserveToolInvocation } from '../tools/gateway.js';
import type { ToolContext, ToolPayload } from '../tools/contracts.js';

const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

async function invokeTurnTool(
  pool: Pool,
  session: RunSession,
  toolId: 'request_cancel_task' | 'propose_task' | 'list_tasks',
  args: unknown,
) {
  const ctx: ToolContext = {
    ownerId: session.context.ownerId,
    conversationId: session.context.conversationId,
    runId: session.context.runId,
    attemptId: session.context.attemptId,
    requestId: session.context.requestId,
    allowlist: [toolId],
    confirmedTimezone: session.context.confirmedTimezone,
    anchorReceivedAtUtc: session.context.anchorReceivedAtUtc,
    receivedAtUtc: session.context.receivedAtUtc,
    foldChoice: session.context.foldChoice,
    timeContext: session.context.timeContext,
  };
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
  if (session.context.reminderNeedsRestatement) {
    await completeClarify(
      pool,
      session,
      write,
      '请完整重述这条提醒的具体日期、时间、时区和事项；不能确定它与原请求的关系。',
    );
    return;
  }

  const text = session.context.reminderInputText ?? session.context.inputText;
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
    const outcome = await invokeTurnTool(pool, session, 'request_cancel_task', {
      task_id: taskId,
      reason_text: text,
    });
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
    const outcome = await invokeTurnTool(pool, session, 'propose_task', {
      raw_time_text: text,
      timezone_hint: session.context.confirmedTimezone,
      note: text,
      occurrence: 'once',
    });
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
  const outcome = await invokeTurnTool(pool, session, 'list_tasks', { limit: 5 });
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
  const authorizedWrite: EventWriter = async (event, authority) => {
    if (authority === 'held') return write(event);
    if (write.ready && !(await write.ready())) return false;
    return writeAuthorizedEvent(pool, context.ownerId, write, event);
  };
  if (write.ready) authorizedWrite.ready = write.ready;
  const execution = await withTransaction(
    pool,
    async (client) => (await lockRun(client, context, true, false)).run.execution,
  );
  if (execution === 'harness') {
    await executeAttempt(deps, context, authorizedWrite, {
      signal,
      onDisconnect: () =>
        cancelConversationRun(
          deps,
          context.ownerId,
          context.conversationId,
          context.runId,
          context.requestId,
          { idempotency_key: randomUUID(), reason: 'client_disconnected' },
        ),
    });
    return;
  }
  const session: RunSession = {
    context,
    terminal: false,
  };
  try {
    await executeBusinessTurn(pool, session, authorizedWrite);
  } catch {
    if (session.terminal) return;
    // Accounting for an already accepted attempt must survive revocation,
    // but the committed failure is not itself authority to disclose it.
    try {
      const failed = await withTransaction(pool, async (client) => {
        await lockRun(client, context, true, false);
        return commitTerminal(client, context, 'failed', {
          conversation_id: context.conversationId,
          run_id: context.runId,
          error: {
            code: 'INTERNAL_ERROR',
            message: '内部错误，请稍后重试。',
            http_status: 500,
          },
        });
      });
      session.terminal = true;
      await withTransaction(pool, (client) => lockRun(client, context, false));
      await authorizedWrite(failed);
    } catch {
      if (session.terminal) return;
    }
  }
}
