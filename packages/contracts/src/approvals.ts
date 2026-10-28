import { z } from 'zod';

export const ApprovalStatusSchema = z.enum([
  'pending',
  'consumed',
  'rejected',
  'expired',
  'superseded',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalDetailSchema = z
  .object({
    approval_id: z.string().uuid(),
    kind: z.enum(['create_task', 'cancel_task']),
    status: ApprovalStatusSchema,
    echo_text: z.string(),
    original_text: z.string().nullable(),
    fire_at_local: z.string(),
    expires_in_seconds: z.number().int().nonnegative(),
    snapshot: z
      .object({
        fire_at_utc: z.string(),
        timezone_id: z.string(),
        fold: z.number(),
        offset_seconds: z.number(),
      })
      .strict(),
    presentation_hash: z.string(),
    presentation_version: z.string(),
    expires_at: z.string(),
    recreated_from: z.string().nullable(),
    result: z
      .object({
        task_id: z.string().uuid().nullable(),
        successor_approval_id: z.string().uuid().nullable(),
      })
      .strict(),
  })
  .strict()
  .refine((detail) => detail.status !== 'consumed' || detail.result.task_id !== null, {
    message: 'consumed task approval requires its real task result',
    path: ['result', 'task_id'],
  });
export type ApprovalDetail = z.infer<typeof ApprovalDetailSchema>;
