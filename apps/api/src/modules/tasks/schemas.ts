import { z } from 'zod';

export const TaskListQuerySchema = z.object({
  status: z
    .enum([
      'saved',
      'pending_schedule',
      'scheduled',
      'fired',
      'missed',
      'cancel_pending',
      'cancelled',
      'all',
    ])
    .default('all'),
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type TaskListQuery = z.infer<typeof TaskListQuerySchema>;

export const TaskItemSchema = z.object({
  task_id: z.string().uuid(),
  state: z.string(),
  fire_at_utc: z.string(),
  fire_at_local: z.string(),
  timezone_id: z.string(),
  source_approval_id: z.string().nullable(),
  schedule_receipt: z.string().nullable(),
});

export const TaskDetailSchema = z.object({
  task_id: z.string().uuid(),
  kind: z.string(),
  state: z.string(),
  state_version: z.number(),
  fire_at_utc: z.string(),
  fire_at_local: z.string(),
  timezone_id: z.string(),
  source_approval_id: z.string().nullable(),
  recreated_from: z.string().nullable(),
  schedule_receipt: z.string().nullable(),
  created_at: z.string(),
  notifications: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      body: z.string(),
      status: z.enum(['pending', 'sent', 'failed']),
      sent_at: z.string().datetime().nullable(),
    }),
  ),
});

export const TaskEventItemSchema = z.object({
  event_id: z.string().uuid(),
  type: z.string(),
  recorded_at_utc: z.string(),
  state_version: z.number(),
  evidence_ref: z.string(),
});

export const TaskEventsQuerySchema = z.object({
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type TaskEventsQuery = z.infer<typeof TaskEventsQuerySchema>;

// Outbox command staged by confirm (PR2). Minimal shape per plan: the
// scheduler (#8) owns the vocabulary; approvals only needs to know the
// envelope fields it writes.
export const OutboxCommandSchema = z.object({
  kind: z.literal('schedule'),
  task_id: z.string().uuid(),
  fire_at_utc: z.string(),
  timezone_id: z.string(),
  expected_state_version: z.number(),
  idempotency_key: z.string(),
});

export type OutboxCommand = z.infer<typeof OutboxCommandSchema>;
