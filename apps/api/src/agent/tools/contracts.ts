import type { CreatedApproval } from '../../features/approvals/public.js';
import type { TimeContext, TimeFailure } from '../../features/time/public.js';
import type { FeishuBotDocxGrant } from '../../features/office-connectors/public.js';
import type { LearnDocsSearchPayload } from '@along/contracts';
import type {
  WorkspaceGrant,
  WorkspaceResult,
  DocumentApprovalReceipt,
  ElapsedTimeBasis,
  HarnessMemorySourceSchema,
} from '@along/contracts';
import type { RunOwnership } from '../execution/driver/ownership.js';
import type { z } from 'zod';

export const BUSINESS_TOOL_IDS = [
  'propose_task',
  'request_cancel_task',
  'list_tasks',
  'read_brief_cards',
  'get_user_prefs',
] as const;
export const WORKSPACE_TOOL_IDS = [
  'workspace_list',
  'workspace_grep',
  'workspace_read',
  'workspace_propose_replace',
  'workspace_apply_replace',
] as const;
export const DELEGATION_WORKSPACE_READ_TOOL_IDS = [
  'workspace_list',
  'workspace_grep',
  'workspace_read',
] as const;
export const DELEGATION_WORKSPACE_WRITE_TOOL_IDS = [
  'workspace_replace',
  'workspace_propose_replace',
  'workspace_apply_replace',
] as const;
export const DELEGATION_WORKSPACE_CREATE_TOOL_IDS = ['workspace_create'] as const;
export const CONTEXT_TOOL_IDS = ['read_run_observation'] as const;
export const R3_MEMORY_TOOL_IDS = ['remember_memory', 'recall_memories'] as const;
export const R3_MEMORY_SOURCE_TOOL_ID = 'read_memory_source' as const;
export const HARNESS_BASE_TOOL_IDS = [...BUSINESS_TOOL_IDS, ...CONTEXT_TOOL_IDS] as const;
export const DELEGATION_TOOL_IDS = [
  'get_user_prefs',
  'set_user_timezone',
  'create_reminder',
  'list_tasks',
  'get_task',
  'cancel_reminder',
  'read_brief_cards',
  'read_run_observation',
] as const;
export const TOOL_IDS = [...BUSINESS_TOOL_IDS, ...WORKSPACE_TOOL_IDS, ...CONTEXT_TOOL_IDS] as const;
export type ToolId =
  | (typeof TOOL_IDS)[number]
  | (typeof DELEGATION_TOOL_IDS)[number]
  | (typeof DELEGATION_WORKSPACE_WRITE_TOOL_IDS)[number]
  | (typeof DELEGATION_WORKSPACE_CREATE_TOOL_IDS)[number]
  | (typeof R3_MEMORY_TOOL_IDS)[number]
  | typeof R3_MEMORY_SOURCE_TOOL_ID
  | 'feishu_docx_read'
  | 'learn_docs_search';

export const TASK_STATES = [
  'saved',
  'pending_schedule',
  'scheduled',
  'fired',
  'missed',
  'cancel_pending',
  'cancelled',
] as const;

export interface ToolContext {
  ownerId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  ownership?: RunOwnership;
  requestId: string;
  allowlist: readonly string[];
  authorizationRevision?: 'delegation/1';
  confirmedTimezone: string | null;
  anchorReceivedAtUtc: string;
  receivedAtUtc: string;
  foldChoice: 'first' | 'second' | 'none';
  timeContext: TimeContext;
  workspaceGrant?: WorkspaceGrant | null;
  workspaceGrants?: WorkspaceGrant[];
  feishuDocx?: { connectionId: string; sessionId: string; url: string } | FeishuBotDocxGrant;
  formLearnQuery?: (signal: AbortSignal) => Promise<string | null>;
  documentEdit?: {
    base_read_invocation_id: string;
    relative_path: string;
    base_version: string;
    exact_new_content?: string;
    new_version?: string;
    operation_error?: 'literal_not_found' | 'literal_not_unique' | 'unchanged';
    replaces_invocation_id?: string;
  };
  documentCreate?: {
    output_directory: string;
    directory_identity: string;
    relative_path: string;
    content_base64: string;
    new_version: string;
    replaces_invocation_id?: string;
  };
  signal?: AbortSignal;
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
  next_cursor?: string | null;
}
export interface TaskDetailPayload {
  kind: 'task_detail';
  task: {
    task_id: string;
    note: string | null;
    fire_at_local_text: string;
    timezone_id: string;
    state: string;
  };
}
export interface ReminderCancelledPayload {
  kind: 'reminder_cancelled';
  task_id: string;
  state: string;
  duplicate: boolean;
}
export interface BriefPayload {
  kind: 'brief';
  brief_id: string;
  date: string;
  timezone_id?: string;
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
export interface TimezoneSettingPayload {
  kind: 'timezone_setting';
  timezone_id: string | null;
  previous_timezone_id: string | null;
  alias_version: string;
}
export interface TaskCreatedPayload {
  kind: 'task_created';
  task_id: string;
  state: 'saved';
  wall_time: string;
  timezone_id: string;
  fold: 0 | 1;
  resolved_utc_offset_seconds: number;
  tzdb_version: string | null;
  time_basis?: ElapsedTimeBasis;
  display_version?: 'elapsed/1';
  fire_at_utc: string;
  original_note: string | null;
}
// Internal non-transactional evidence, not a registered product tool.
export interface EvidencePayload {
  kind: 'effect_evidence';
  evidence_ref: string;
}
export interface DocumentApprovalPayload {
  kind: 'document_approval';
  approval: DocumentApprovalReceipt;
}
export interface MemorySavedPayload {
  kind: 'memory_saved';
  memory_id: string;
  content: string;
}
export interface MemoryRecallPayload {
  kind: 'memory_recall';
  items: {
    memory_id: string;
    content: string;
    match?: 'literal' | 'semantic' | 'unfiltered';
    conversation_id: string | null;
    message_ids: string[];
    created_at: string;
    updated_at: string;
  }[];
  completeness: 'complete' | 'degraded' | 'incomplete';
}
export type MemorySourcePayload = z.infer<typeof HarnessMemorySourceSchema>;
export interface FeishuDocxPayload {
  kind: 'feishu_docx_read';
  source: { type: 'feishu_docx'; url: string; title: string; identity?: 'bot' };
  revision: { before: number; after: number };
  fetched_at: string;
  content_hash: string;
  representation: 'plain_text';
  completeness: 'complete_plain_text';
  content: string;
}
export type ToolPayload =
  | ApprovalPayload
  | DocumentApprovalPayload
  | ClarifyPayload
  | TimeErrorPayload
  | ListTasksPayload
  | TaskDetailPayload
  | ReminderCancelledPayload
  | BriefPayload
  | PrefsPayload
  | TimezoneSettingPayload
  | TaskCreatedPayload
  | MemorySavedPayload
  | MemoryRecallPayload
  | MemorySourcePayload
  | FeishuDocxPayload
  | LearnDocsSearchPayload
  | EvidencePayload
  | WorkspaceResult;
export type ToolResult =
  | { status: 'ok'; result: ToolPayload }
  | { status: 'denied'; error: { code: string; message: string } }
  | { status: 'failed'; error: { code: string; message: string } }
  | { status: 'unknown'; error: { code: string; message: string } };
export type ToolOutcome = ToolResult & { invocationId: string; replayed: boolean };
export type ExecutionKind = 'local' | 'read_only' | 'non_transactional';
export interface InvocationInput {
  invocationId: string;
  toolId: string;
  args: unknown;
}
export interface ReservationInput {
  callKey: string;
  toolId: string;
  args: unknown;
  executionKind: ExecutionKind;
}
