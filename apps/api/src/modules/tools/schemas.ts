// ToolGateway input contracts (issue #9): docs/agent/02 §v0 五工具 schema.
// Every schema is .strict(): unknown fields (including injected runtime ids
// such as user_id/conversation_id/run_id/request_id and time internals such as
// fire_at_utc/fold/offset) are rejected at the gateway and audited as deny.
import { z } from 'zod';

import { TASK_STATES } from './contracts.js';

export const ProposeTaskInputSchema = z
  .object({
    raw_time_text: z.string().min(1).max(1000),
    timezone_hint: z.string().min(1).max(100).nullable().optional(),
    note: z.string().min(1).max(1000),
    occurrence: z.literal('once'),
  })
  .strict();

export type ProposeTaskInput = z.infer<typeof ProposeTaskInputSchema>;
export const CreateReminderInputSchema = z.union([
  ProposeTaskInputSchema,
  z
    .object({
      raw_time_text: z.string().min(1).max(1000),
      timezone_hint: z.string().min(1).max(100).nullable().optional(),
      note: z.string().min(1).max(1000),
      occurrence: z.literal('once'),
      time_kind: z.literal('elapsed'),
      duration_seconds: z.number().int().positive().safe(),
    })
    .strict(),
]);

export const RequestCancelTaskInputSchema = z
  .object({
    task_id: z.string().uuid(),
    reason_text: z.string().max(1000).nullable().optional(),
  })
  .strict();

export type RequestCancelTaskInput = z.infer<typeof RequestCancelTaskInputSchema>;

export const ListTasksInputSchema = z
  .object({
    state: z.enum(TASK_STATES).nullable().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export type ListTasksInput = z.infer<typeof ListTasksInputSchema>;
export const PaginatedListTasksInputSchema = ListTasksInputSchema.extend({
  after_task_id: z.string().uuid().optional(),
  future_only: z.boolean().optional(),
});
export const TaskIdInputSchema = z.object({ task_id: z.string().uuid() }).strict();
export const CancelReminderInputSchema = TaskIdInputSchema.extend({
  expected_note: z.string().max(1000).nullable().optional(),
  expected_wall_time: z.string().min(1).max(64).optional(),
  expected_timezone_id: z.string().min(1).max(100).optional(),
});

export const ReadBriefCardsInputSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    card_ids: z.array(z.string().uuid()).max(50).nullable().optional(),
  })
  .strict();

export type ReadBriefCardsInput = z.infer<typeof ReadBriefCardsInputSchema>;

export const GetUserPrefsInputSchema = z.object({}).strict();

export type GetUserPrefsInput = z.infer<typeof GetUserPrefsInputSchema>;

export const SetUserTimezoneInputSchema = z
  .object({ timezone_id: z.string().min(1).max(100).nullable() })
  .strict();

export type SetUserTimezoneInput = z.infer<typeof SetUserTimezoneInputSchema>;

export const WorkspaceListInputSchema = z.object({ path: z.string() }).strict();
export const WorkspaceGrepInputSchema = z
  .object({ path: z.string(), literal: z.string().min(1) })
  .strict();
export const WorkspaceReadInputSchema = z.object({ path: z.string().min(1) }).strict();
export const WorkspaceProposeReplaceInputSchema = z
  .object({
    read_invocation_id: z.string().uuid(),
    old_text: z.string().min(1),
    new_text: z.string(),
  })
  .strict();
export const WorkspaceApplyReplaceInputSchema = z
  .object({ approval_id: z.string().uuid() })
  .strict();
export const DelegatedWorkspaceListInputSchema = WorkspaceListInputSchema.extend({
  workspace_id: z.string().min(1),
});
export const DelegatedWorkspaceGrepInputSchema = WorkspaceGrepInputSchema.extend({
  workspace_id: z.string().min(1),
});
export const DelegatedWorkspaceReadInputSchema = WorkspaceReadInputSchema.extend({
  workspace_id: z.string().min(1),
});
export const WorkspaceChangeSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('literal'), old_text: z.string().min(1), new_text: z.string() })
    .strict(),
  z.object({ kind: z.literal('full'), new_content: z.string() }).strict(),
]);
export const WorkspaceReplaceInputSchema = z
  .object({
    read_invocation_id: z.string().uuid(),
    change: WorkspaceChangeSchema,
  })
  .strict();
export const WorkspaceCreateInputSchema = z
  .object({
    workspace_id: z.string().min(1),
    output_directory: z.string(),
    filename: z.string().min(1),
    content: z.string(),
  })
  .strict();
export const DelegatedWorkspaceProposeInputSchema = WorkspaceReplaceInputSchema;
export const DELEGATED_WORKSPACE_READ_SCHEMAS = {
  workspace_list: DelegatedWorkspaceListInputSchema,
  workspace_grep: DelegatedWorkspaceGrepInputSchema,
  workspace_read: DelegatedWorkspaceReadInputSchema,
} as const;

export const ReadRunObservationInputSchema = z
  .object({
    source_invocation_id: z.string().uuid(),
    field: z.enum(['content', 'matches', 'entries', 'failures']),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type ReadRunObservationInput = z.infer<typeof ReadRunObservationInputSchema>;

export const TOOL_INPUT_SCHEMAS = {
  propose_task: ProposeTaskInputSchema,
  create_reminder: CreateReminderInputSchema,
  request_cancel_task: RequestCancelTaskInputSchema,
  list_tasks: ListTasksInputSchema,
  get_task: TaskIdInputSchema,
  cancel_reminder: CancelReminderInputSchema,
  read_brief_cards: ReadBriefCardsInputSchema,
  get_user_prefs: GetUserPrefsInputSchema,
  set_user_timezone: SetUserTimezoneInputSchema,
  workspace_list: WorkspaceListInputSchema,
  workspace_grep: WorkspaceGrepInputSchema,
  workspace_read: WorkspaceReadInputSchema,
  workspace_propose_replace: WorkspaceProposeReplaceInputSchema,
  workspace_replace: WorkspaceReplaceInputSchema,
  workspace_create: WorkspaceCreateInputSchema,
  workspace_apply_replace: WorkspaceApplyReplaceInputSchema,
  read_run_observation: ReadRunObservationInputSchema,
} as const;
