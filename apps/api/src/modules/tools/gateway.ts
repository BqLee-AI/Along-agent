// The gateway binds each logical tool call before executing local work.
// Approved results, local approval inserts and audit rows commit together.
import type { Pool, PoolClient } from 'pg';
import { normalizeTime } from '../time/normalize.js';
import { createCancelTaskApproval, createTaskApproval } from '../approvals/create.js';
import {
  renderEchoCancelV1,
  renderCreateTaskEcho,
  shortNoOf,
  type PresentationSnapshot,
} from '../approvals/presentation.js';
import { readCancelTaskCandidate, readToolTaskList } from '../tasks/tool-query.js';
import { readToolBriefCards } from '../brief/tool-query.js';
import { readUserPreferences } from '../identity/preferences.js';
import { TOOL_INPUT_SCHEMAS } from './schemas.js';
import type { ToolContext, ToolOutcome, ToolPayload, ToolResult } from './contracts.js';
import {
  executeLocalInvocation,
  executeReadOnlyInvocation,
  executeNonTransactionalInvocation,
  reserveInvocation,
} from './invocations.js';
import { HttpError } from '../../http/errors.js';
import {
  createDocumentApproval,
  validateDocumentApprovalApply,
  DocumentProposalOperationError,
} from '../approvals/document-service.js';
import { applyWorkspaceReplace, type ApprovedWorkspaceTarget } from '../workspaces/replace.js';
import { utf8Bytes, WorkspaceDeniedError } from '../workspaces/service.js';
import { callWorkspaceMcp, type WorkspaceReadTool } from './mcp-workspace.js';
import { readRunDocumentEvidence } from './query.js';
import { readObservationPage } from './observation-page.js';

const workspaceDenied = (): ToolResult => ({
  status: 'denied',
  error: { code: 'TOOL_FORBIDDEN', message: '当前工作区或文档动作未获授权。' },
});

async function runWorkspaceProposal(
  client: PoolClient,
  ctx: ToolContext,
  args: unknown,
): Promise<ToolResult> {
  const parsed = TOOL_INPUT_SCHEMAS.workspace_propose_replace.safeParse(args);
  if (!parsed.success || !ctx.workspaceGrant) return workspaceDenied();
  let path = '';
  try {
    utf8Bytes(parsed.data.old_text);
    utf8Bytes(parsed.data.new_text);
    const evidence = await readRunDocumentEvidence(client, ctx);
    const baseRead = evidence.reads.find(
      (read) => read.invocation_id === parsed.data.read_invocation_id,
    );
    if (!baseRead) return workspaceDenied();
    path = baseRead.relative_path;
    if (parsed.data.old_text === parsed.data.new_text)
      return { status: 'ok', result: { kind: 'operation_error', path, reason: 'unchanged' } };
    const approval = await createDocumentApproval(client, {
      ownerId: ctx.ownerId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      workspaceGrant: ctx.workspaceGrant,
      relativePath: path,
      baseRead,
      oldText: parsed.data.old_text,
      newText: parsed.data.new_text,
      evidence,
    });
    return { status: 'ok', result: { kind: 'document_approval', approval } };
  } catch (error) {
    if (error instanceof WorkspaceDeniedError) return workspaceDenied();
    if (error instanceof DocumentProposalOperationError)
      return { status: 'ok', result: { kind: 'operation_error', path, reason: error.reason } };
    if (error instanceof HttpError) return workspaceDenied();
    throw error;
  }
}

function invokeWorkspaceApply(
  pool: Pool,
  ctx: ToolContext,
  input: { invocationId: string; toolId: string; args: unknown },
): Promise<ToolOutcome> {
  let target: ApprovedWorkspaceTarget | undefined;
  let frozen: ToolContext | undefined;
  return executeNonTransactionalInvocation(pool, ctx, input, {
    validateDispatch: async (client, context, binding) => {
      const args = TOOL_INPUT_SCHEMAS.workspace_apply_replace.parse(input.args);
      if (!context.workspaceGrant) throw new WorkspaceDeniedError();
      const receipt = await validateDocumentApprovalApply(client, {
        ownerId: context.ownerId,
        conversationId: context.conversationId,
        runId: context.runId,
        workspaceGrant: context.workspaceGrant,
        approvalId: args.approval_id,
        invocationId: binding.invocationId,
      });
      frozen = context;
      target = {
        approval_id: receipt.approval_id,
        path: receipt.relative_path,
        base_version: receipt.base_version,
        exact_new_content: receipt.exact_new_content,
        new_version: receipt.new_version,
      };
    },
    execute: async (binding) => {
      if (!target || !frozen?.workspaceGrant) throw new Error('missing authorized frozen target');
      frozen.signal?.throwIfAborted();
      const client = await pool.connect();
      try {
        const result = await applyWorkspaceReplace(
          client,
          frozen.ownerId,
          frozen.workspaceGrant,
          target,
          { invocation_id: binding.invocationId, args_hash: binding.argsHash },
        );
        return {
          ...binding,
          evidenceRef:
            result.kind === 'applied'
              ? result.evidence_ref
              : `workspace-conflict:${binding.invocationId}`,
          result: { status: 'ok', result },
        };
      } finally {
        client.release();
      }
    },
  });
}

const CLARIFY_TEXT: Record<string, string> = {
  ASK_YEAR: '请给年份：日期需要年份才能排期，请补充年份（如 2026 年 10 月 17 日 09:20）。',
  ASK_TIMEZONE: '请给时区：按哪个时区排？（如 Asia/Shanghai；本次确认只用于本次）',
  ASK_TIMEZONE_ALIAS: '这个时区别名认不出来；请给规范 IANA 时区，如 Asia/Shanghai。',
  ASK_DAYPART: '请给明确的时刻；如果用“几点”表达，请说明上午、下午或晚上。',
  ASK_DATE: '请给这条提醒的具体日期，或明确说今天、明天。',
  ASK_DATE_RECONFIRM: '跨天了，请重新给具体日期。',
  ASK_REMINDER_CONTENT: '请给这条提醒的具体事项。',
  ASK_FOLD: '结构化选择与原文冲突，请明确第一次或第二次并重新选择。',
  RANGE_UNSUPPORTED: '范围无法唯一排触发点，请给准确时刻；v0 不支持范围提醒。',
  NO_CALENDAR: 'v0 不读日历不监测空闲，这次不保存；请给明确日期时间时区。',
  ASK_EXACT_TIME: '请给准确的日期和时间；v0 不支持“尽快/晚点”。',
};

interface ToolExecution {
  payload: ToolPayload;
  errorCode: string | null;
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
  client: PoolClient,
  ctx: ToolContext,
  args: unknown,
): Promise<ToolExecution> {
  const parsed = TOOL_INPUT_SCHEMAS.propose_task.safeParse(args);
  if (!parsed.success) {
    return {
      payload: {
        kind: 'clarify',
        reason: 'INVALID_ARGS',
        phrase_key: 'INVALID_ARGS',
        text: '工具参数不合法，已拒绝；请重述提醒内容与时间。',
      },
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
    requireCompleteReminder: true,
    reminderContent: input.note,
  });
  if (result.kind === 'error') {
    return {
      payload: { kind: 'time_error', error: result.error },
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
      errorCode: null,
    };
  }
  const normalized = result.normalized;
  const wallTime = `${result.wall_time.slice(0, 10)} ${result.wall_time.slice(11, 16)}`;
  const fold: 0 | 1 = normalized.fold;
  const approval = await createTaskApproval(client, {
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
    errorCode: null,
  };
}

async function runRequestCancelTask(
  client: PoolClient,
  ctx: ToolContext,
  args: unknown,
): Promise<ToolExecution> {
  const parsed = TOOL_INPUT_SCHEMAS.request_cancel_task.safeParse(args);
  if (!parsed.success) {
    return {
      payload: {
        kind: 'clarify',
        reason: 'INVALID_ARGS',
        phrase_key: 'INVALID_ARGS',
        text: '工具参数不合法，已拒绝；请给出要取消的任务 id。',
      },
      errorCode: 'TOOL_FORBIDDEN',
    };
  }
  const input = parsed.data;
  const task = await readCancelTaskCandidate(client, ctx.ownerId, input.task_id);
  if (!task) {
    return {
      payload: {
        kind: 'clarify',
        reason: 'TOOL_FORBIDDEN',
        phrase_key: 'TOOL_FORBIDDEN',
        text: '没有找到可取消的任务；请确认任务 id。',
      },
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
      errorCode: 'STATE_CONFLICT',
    };
  }
  const originalText = input.reason_text ?? task.original_note ?? '取消提醒';
  const fold: 0 | 1 = task.fold === 1 ? 1 : 0;
  const approval = await createCancelTaskApproval(client, {
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
    errorCode: null,
  };
}

async function runListTasks(
  client: PoolClient,
  ctx: ToolContext,
  args: unknown,
): Promise<ToolExecution> {
  const parsed = TOOL_INPUT_SCHEMAS.list_tasks.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      payload: {
        kind: 'clarify',
        reason: 'INVALID_ARGS',
        phrase_key: 'INVALID_ARGS',
        text: '工具参数不合法，已拒绝。',
      },
      errorCode: null,
    };
  }
  const projection = await readToolTaskList(client, ctx.ownerId, parsed.data);
  return {
    payload: { kind: 'list_tasks', ...projection },
    errorCode: null,
  };
}

async function runReadBriefCards(
  client: PoolClient,
  ctx: ToolContext,
  args: unknown,
): Promise<ToolExecution> {
  const parsed = TOOL_INPUT_SCHEMAS.read_brief_cards.safeParse(args);
  if (!parsed.success) {
    return {
      payload: {
        kind: 'clarify',
        reason: 'INVALID_ARGS',
        phrase_key: 'INVALID_ARGS',
        text: '日期格式不合法；请给 YYYY-MM-DD。',
      },
      errorCode: null,
    };
  }
  const projection = await readToolBriefCards(client, ctx.ownerId, parsed.data);
  return {
    payload: { kind: 'brief', ...projection },
    errorCode: null,
  };
}

async function runGetUserPrefs(
  client: PoolClient,
  ctx: ToolContext,
  args: unknown,
): Promise<ToolExecution> {
  if (!TOOL_INPUT_SCHEMAS.get_user_prefs.safeParse(args).success) {
    return {
      payload: {
        kind: 'clarify',
        reason: 'INVALID_ARGS',
        phrase_key: 'INVALID_ARGS',
        text: '工具参数不合法，已拒绝。',
      },
      errorCode: 'TOOL_FORBIDDEN',
    };
  }
  const preferences = await readUserPreferences(client, ctx.ownerId);
  return {
    payload: {
      kind: 'prefs',
      timezone_id: preferences.timezone_id,
      alias_version: ctx.timeContext.available ? ctx.timeContext.aliases.version : 'unavailable',
      quiet_hours: null,
      locale: null,
    },
    errorCode: null,
  };
}

export function reserveToolInvocation(
  pool: Pool,
  ctx: ToolContext,
  input: { callKey: string; toolId: string; args: unknown },
): Promise<{ invocationId: string }> {
  const readOnly = [
    'list_tasks',
    'read_brief_cards',
    'get_user_prefs',
    'workspace_list',
    'workspace_grep',
    'workspace_read',
    'read_run_observation',
  ].includes(input.toolId);
  return reserveInvocation(pool, ctx, {
    ...input,
    executionKind:
      input.toolId === 'workspace_apply_replace'
        ? 'non_transactional'
        : readOnly
          ? 'read_only'
          : 'local',
  });
}

export function invokeTool(
  pool: Pool,
  ctx: ToolContext,
  input: { invocationId: string; toolId: string; args: unknown },
): Promise<ToolOutcome> {
  if (input.toolId === 'workspace_apply_replace') return invokeWorkspaceApply(pool, ctx, input);
  if (input.toolId === 'read_run_observation') {
    return executeReadOnlyInvocation(pool, ctx, input, async (frozen) => {
      const parsed = TOOL_INPUT_SCHEMAS.read_run_observation.safeParse(input.args);
      if (!parsed.success) return workspaceDenied();
      const client = await pool.connect();
      try {
        return await readObservationPage(client, frozen, parsed.data);
      } catch (error) {
        if (error instanceof HttpError && error.httpStatus === 403) return workspaceDenied();
        throw error;
      } finally {
        client.release();
      }
    }).catch((error: unknown) => {
      if (error instanceof HttpError && error.httpStatus === 403)
        return { ...workspaceDenied(), invocationId: input.invocationId, replayed: false };
      throw error;
    });
  }
  if (['workspace_list', 'workspace_grep', 'workspace_read'].includes(input.toolId)) {
    const toolId = input.toolId as WorkspaceReadTool;
    return executeReadOnlyInvocation(pool, ctx, input, async (frozen) => {
      const parsed = TOOL_INPUT_SCHEMAS[toolId].safeParse(input.args);
      if (!parsed.success) return workspaceDenied();
      try {
        return { status: 'ok', result: await callWorkspaceMcp(frozen, toolId, parsed.data) };
      } catch (error) {
        if (error instanceof WorkspaceDeniedError) return workspaceDenied();
        throw error;
      }
    });
  }
  return executeLocalInvocation(pool, ctx, input, async (client, frozen) => {
    let executed: ToolExecution;
    switch (input.toolId) {
      case 'workspace_propose_replace':
        return runWorkspaceProposal(client, frozen, input.args);
      case 'propose_task':
        executed = await runProposeTask(client, frozen, input.args);
        break;
      case 'request_cancel_task':
        executed = await runRequestCancelTask(client, frozen, input.args);
        break;
      case 'list_tasks':
        executed = await runListTasks(client, frozen, input.args);
        break;
      case 'read_brief_cards':
        executed = await runReadBriefCards(client, frozen, input.args);
        break;
      case 'get_user_prefs':
        executed = await runGetUserPrefs(client, frozen, input.args);
        break;
      default:
        return { status: 'denied', error: { code: 'TOOL_FORBIDDEN', message: 'unknown tool' } };
    }
    if (executed.errorCode === 'TOOL_FORBIDDEN') {
      return {
        status: 'denied',
        error: { code: 'TOOL_FORBIDDEN', message: 'tool invocation rejected' },
      };
    }
    return { status: 'ok', result: executed.payload };
  });
}
