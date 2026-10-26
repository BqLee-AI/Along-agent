import type { CreatedApproval } from '../approvals/create.js';
import type { TimeContext } from '../time/context.js';
import type { TimeFailure } from '../time/normalize.js';
import type { WorkspaceGrant, WorkspaceResult } from '@along/contracts';
import type { DocumentApprovalReceipt } from '@along/contracts';

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
export const TOOL_IDS = [...BUSINESS_TOOL_IDS, ...WORKSPACE_TOOL_IDS] as const;
export type ToolId = (typeof TOOL_IDS)[number];

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
  requestId: string;
  allowlist: readonly string[];
  confirmedTimezone: string | null;
  anchorReceivedAtUtc: string;
  receivedAtUtc: string;
  foldChoice: 'first' | 'second' | 'none';
  timeContext: TimeContext;
  workspaceGrant?: WorkspaceGrant | null;
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
// Internal non-transactional evidence, not a registered product tool.
export interface EvidencePayload {
  kind: 'effect_evidence';
  evidence_ref: string;
}
export interface DocumentApprovalPayload {
  kind: 'document_approval';
  approval: DocumentApprovalReceipt;
}
export type ToolPayload =
  | ApprovalPayload
  | DocumentApprovalPayload
  | ClarifyPayload
  | TimeErrorPayload
  | ListTasksPayload
  | BriefPayload
  | PrefsPayload
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
