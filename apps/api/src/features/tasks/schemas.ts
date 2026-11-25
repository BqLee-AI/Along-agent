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

export const TaskEventsQuerySchema = z.object({
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// Schedule commands are staged by the tasks creation use case; the scheduler
// owns command consumption and registration receipts.
export const OutboxCommandSchema = z.object({
  kind: z.literal('schedule'),
  task_id: z.string().uuid(),
  fire_at_utc: z.string(),
  timezone_id: z.string(),
  expected_state_version: z.number(),
  idempotency_key: z.string(),
});

export type OutboxCommand = z.infer<typeof OutboxCommandSchema>;
