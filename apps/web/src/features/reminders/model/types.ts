import { ElapsedTimeBasisSchema } from '@along/contracts';
import { z } from 'zod';

export type { ElapsedTimeBasis } from '@along/contracts';

// Frozen reminder fields are rendered exactly as returned by the API.
const taskRecordShape = {
  task_id: z.string().uuid(),
  state: z.string(),
  fire_at_utc: z.string(),
  fire_at_local: z.string(),
  timezone_id: z.string(),
  fold: z.number().int().optional(),
  resolved_utc_offset_seconds: z.number().int().optional(),
  tzdb_version: z.string().nullable().optional(),
  source_approval_id: z.string().nullable(),
  source_invocation_id: z.string().uuid().nullable(),
  schedule_receipt: z.string().nullable(),
  time_basis: ElapsedTimeBasisSchema.nullable().optional(),
  display_version: z.literal('elapsed/1').nullable().optional(),
};

export const TaskListItemSchema = z.object(taskRecordShape).strict();
export type TaskListItem = z.infer<typeof TaskListItemSchema>;

export const TaskDetailSchema = z
  .object({
    ...taskRecordShape,
    kind: z.string(),
    state_version: z.number(),
    recreated_from: z.string().nullable(),
    created_at: z.string(),
    notifications: z.array(
      z
        .object({
          id: z.string().uuid(),
          title: z.string(),
          body: z.string(),
          status: z.enum(['pending', 'sent', 'failed']),
          sent_at: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export interface TaskEventItem {
  event_id: string;
  type: string;
  recorded_at_utc: string;
  state_version: number;
  evidence_ref: string;
}
