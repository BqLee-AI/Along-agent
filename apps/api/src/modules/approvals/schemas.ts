import { z } from 'zod';

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
