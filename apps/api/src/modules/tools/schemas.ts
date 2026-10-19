// ToolGateway input contracts (issue #9): docs/agent/02 §v0 五工具 schema.
// Every schema is .strict(): unknown fields (including injected runtime ids
// such as user_id/conversation_id/run_id/request_id and time internals such as
// fire_at_utc/fold/offset) are rejected at the gateway and audited as deny.
import { z } from "zod";

export const TOOL_IDS = [
  "propose_task",
  "request_cancel_task",
  "list_tasks",
  "read_brief_cards",
  "get_user_prefs",
] as const;

export type ToolId = (typeof TOOL_IDS)[number];

export const TASK_STATES = [
  "saved",
  "pending_schedule",
  "scheduled",
  "fired",
  "missed",
  "cancel_pending",
  "cancelled",
] as const;

export const ProposeTaskInputSchema = z
  .object({
    raw_time_text: z.string().min(1).max(1000),
    timezone_hint: z.string().min(1).max(100).nullable().optional(),
    note: z.string().min(1).max(1000),
    occurrence: z.literal("once"),
  })
  .strict();

export type ProposeTaskInput = z.infer<typeof ProposeTaskInputSchema>;

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

export const ReadBriefCardsInputSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    card_ids: z.array(z.string().uuid()).max(50).nullable().optional(),
  })
  .strict();

export type ReadBriefCardsInput = z.infer<typeof ReadBriefCardsInputSchema>;

export const GetUserPrefsInputSchema = z.object({}).strict();

export type GetUserPrefsInput = z.infer<typeof GetUserPrefsInputSchema>;

export const TOOL_INPUT_SCHEMAS = {
  propose_task: ProposeTaskInputSchema,
  request_cancel_task: RequestCancelTaskInputSchema,
  list_tasks: ListTasksInputSchema,
  read_brief_cards: ReadBriefCardsInputSchema,
  get_user_prefs: GetUserPrefsInputSchema,
} as const;
