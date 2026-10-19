import { z } from 'zod';

// Notifications are an internal table (no public routes in v0). This schema
// validates worker-side notice construction only.
export const InAppNoticeSchema = z.object({
  owner_id: z.string().uuid(),
  task_id: z.string().uuid(),
  wall_time: z.string().min(1),
  timezone_id: z.string().min(1),
  original_note: z.string().nullable(),
  idempotency_key: z.string().min(1),
});

export type InAppNoticeInput = z.infer<typeof InAppNoticeSchema>;
