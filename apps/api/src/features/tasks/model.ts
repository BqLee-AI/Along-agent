import { z } from 'zod';
export { CancelBodySchema } from './cancellation/cancel.js';
import { ElapsedTimeBasisSchema as timeBasis } from '@along/contracts';
export const TaskItemSchema = z.object({
  task_id: z.string(),
  state: z.string(),
  fire_at_utc: z.string(),
  fire_at_local: z.string(),
  timezone_id: z.string(),
  fold: z.number(),
  resolved_utc_offset_seconds: z.number(),
  tzdb_version: z.string().nullable(),
  time_basis: timeBasis.nullable(),
  display_version: z.literal('elapsed/1').nullable(),
  source_approval_id: z.string().nullable(),
  source_invocation_id: z.string().nullable(),
  schedule_receipt: z.string().nullable(),
});
export const TaskListSchema = z.object({
  items: z.array(TaskItemSchema),
  next_cursor: z.string().nullable(),
});
export const TaskDetailSchema = TaskItemSchema.extend({
  kind: z.string(),
  state_version: z.number(),
  recreated_from: z.string().nullable(),
  created_at: z.string(),
  notifications: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      body: z.string(),
      status: z.enum(['pending', 'sent', 'failed']),
      sent_at: z.string().nullable(),
    }),
  ),
});
export const TaskEventsSchema = z.object({
  items: z.array(
    z.object({
      event_id: z.string(),
      type: z.string(),
      recorded_at_utc: z.string(),
      state_version: z.number(),
      evidence_ref: z.string(),
    }),
  ),
  next_cursor: z.string().nullable(),
});
export const CancelResultSchema = z.object({
  task_id: z.string(),
  state: z.string(),
  duplicate: z.boolean(),
});
