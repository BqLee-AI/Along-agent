import type { Pool, PoolClient } from 'pg';
import type {
  ExecutionKind,
  InvocationInput,
  ToolContext,
  ToolId,
  ToolOutcome,
  ToolResult,
} from './contracts.js';
import { executeLocalInvocation } from './invocations/invocations.js';
import type { ToolExecution } from './handler-common.js';
import {
  runProposeTask,
  runCreateReminder,
  runRequestCancelTask,
  runListTasks,
  runGetTask,
  runCancelReminder,
} from './reminders/reminder-handlers.js';
import { runReadBriefCards, runGetUserPrefs, runSetUserTimezone } from './preference-handlers.js';
import {
  runWorkspaceProposal,
  invokeWorkspaceApply,
  invokeWorkspaceReplace,
  invokeWorkspaceCreate,
  invokeWorkspaceRead,
} from './workspace/workspace-handlers.js';
import { invokeMemorySource, invokeMemoryRecall, runRememberMemory } from './memory-handlers.js';
import { invokeRunObservation } from './observation-handler.js';
import { invokeFeishuDocxRead } from './feishu/docx-read.js';
import { invokeOfficeTool } from './office/handlers.js';

interface ToolDefinition {
  executionKind: ExecutionKind;
  invoke(pool: Pool, context: ToolContext, input: InvocationInput): Promise<ToolOutcome>;
}

type LocalHandler = (
  pool: Pool,
  client: PoolClient,
  context: ToolContext,
  input: InvocationInput,
) => Promise<ToolResult>;
const local =
  (handler: LocalHandler): ToolDefinition['invoke'] =>
  (pool, context, input) =>
    executeLocalInvocation(pool, context, input, (client, frozen) =>
      handler(pool, client, frozen, input),
    );

async function project(executed: Promise<ToolExecution>): Promise<ToolResult> {
  const result = await executed;
  return result.errorCode === 'TOOL_FORBIDDEN'
    ? { status: 'denied', error: { code: 'TOOL_FORBIDDEN', message: 'tool invocation rejected' } }
    : { status: 'ok', result: result.payload };
}

/** The one static binding of execution category and handler. No runtime registration. */
const definitions: Record<ToolId, ToolDefinition> = {
  propose_task: {
    executionKind: 'local',
    invoke: local((_pool, client, ctx, input) => project(runProposeTask(client, ctx, input.args))),
  },
  request_cancel_task: {
    executionKind: 'local',
    invoke: local((_pool, client, ctx, input) =>
      project(runRequestCancelTask(client, ctx, input.args)),
    ),
  },
  create_reminder: {
    executionKind: 'local',
    invoke: local((_pool, client, ctx, input) =>
      runCreateReminder(client, ctx, input.args, input.invocationId),
    ),
  },
  cancel_reminder: {
    executionKind: 'local',
    invoke: local((_pool, client, ctx, input) =>
      runCancelReminder(client, ctx, input.args, input.invocationId),
    ),
  },
  set_user_timezone: {
    executionKind: 'local',
    invoke: local((_pool, client, ctx, input) => runSetUserTimezone(client, ctx, input.args)),
  },
  list_tasks: {
    executionKind: 'read_only',
    invoke: local((_pool, client, ctx, input) => project(runListTasks(client, ctx, input.args))),
  },
  get_task: {
    executionKind: 'read_only',
    invoke: local((_pool, client, ctx, input) => runGetTask(client, ctx, input.args)),
  },
  read_brief_cards: {
    executionKind: 'read_only',
    invoke: local((_pool, client, ctx, input) =>
      project(runReadBriefCards(client, ctx, input.args)),
    ),
  },
  get_user_prefs: {
    executionKind: 'read_only',
    invoke: local((_pool, client, ctx, input) => project(runGetUserPrefs(client, ctx, input.args))),
  },
  workspace_list: { executionKind: 'read_only', invoke: invokeWorkspaceRead },
  workspace_grep: { executionKind: 'read_only', invoke: invokeWorkspaceRead },
  workspace_read: { executionKind: 'read_only', invoke: invokeWorkspaceRead },
  feishu_docx_read: { executionKind: 'read_only', invoke: invokeFeishuDocxRead },
  office_read_notes: { executionKind: 'read_only', invoke: invokeOfficeTool },
  office_analyze_tasks: { executionKind: 'read_only', invoke: invokeOfficeTool },
  office_create_artifacts: { executionKind: 'local', invoke: invokeOfficeTool },
  workspace_propose_replace: {
    executionKind: 'local',
    invoke: local((_pool, client, ctx, input) => runWorkspaceProposal(client, ctx, input.args)),
  },
  workspace_apply_replace: { executionKind: 'non_transactional', invoke: invokeWorkspaceApply },
  workspace_replace: { executionKind: 'non_transactional', invoke: invokeWorkspaceReplace },
  workspace_create: { executionKind: 'non_transactional', invoke: invokeWorkspaceCreate },
  read_run_observation: { executionKind: 'read_only', invoke: invokeRunObservation },
  read_memory_source: { executionKind: 'local', invoke: invokeMemorySource },
  recall_memories: { executionKind: 'read_only', invoke: invokeMemoryRecall },
  remember_memory: { executionKind: 'local', invoke: local(runRememberMemory) },
};

const unknownTool: ToolDefinition = {
  executionKind: 'local',
  invoke: local(async () => ({
    status: 'denied',
    error: { code: 'TOOL_FORBIDDEN', message: 'unknown tool' },
  })),
};

export function toolDefinition(toolId: string): ToolDefinition {
  return Object.hasOwn(definitions, toolId) ? definitions[toolId as ToolId] : unknownTool;
}
