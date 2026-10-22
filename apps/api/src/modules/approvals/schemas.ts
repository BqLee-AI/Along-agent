import { z } from 'zod';

export const ApprovalStatusSchema = z.enum([
  'pending',
  'consumed',
  'rejected',
  'expired',
  'superseded',
]);

export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalListQuerySchema = z.object({
  status: z
    .enum(['pending', 'consumed', 'rejected', 'expired', 'superseded', 'all'])
    .default('pending'),
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type ApprovalListQuery = z.infer<typeof ApprovalListQuerySchema>;

export const ApprovalItemSchema = z.object({
  approval_id: z.string().uuid(),
  title: z.string(),
  status: z.string(),
  expires_at: z.string(),
  created_at: z.string(),
});

export const ApprovalDetailSchema = z.object({
  approval_id: z.string().uuid(),
  kind: z.enum(['create_task', 'cancel_task']),
  status: z.string(),
  echo_text: z.string(),
  original_text: z.string().nullable(),
  fire_at_local: z.string(),
  expires_in_seconds: z.number().int().nonnegative(),
  snapshot: z.object({
    fire_at_utc: z.string(),
    timezone_id: z.string(),
    fold: z.number(),
    offset_seconds: z.number(),
  }),
  presentation_hash: z.string(),
  presentation_version: z.string(),
  expires_at: z.string(),
  recreated_from: z.string().nullable(),
});
export const ConfirmBodySchema = z.object({
  presentation_hash: z.string().min(1).max(200),
  seen_content: z.string().min(1).max(20000),
  idempotency_key: z.string().uuid(),
});

export type ConfirmBody = z.infer<typeof ConfirmBodySchema>;

export const RejectBodySchema = z.object({
  reason: z.string().max(2000).optional(),
  idempotency_key: z.string().uuid(),
});

export type RejectBody = z.infer<typeof RejectBodySchema>;

export const ReviseBodySchema = z
  .object({
    raw_text: z.string().min(1).max(20000),
    confirmed_timezone: z.string().min(1).max(100),
    fold_choice: z.enum(['first', 'second', 'none']).default('none'),
    idempotency_key: z.string().uuid(),
  })
  .strict();

export type ReviseBody = z.infer<typeof ReviseBodySchema>;
