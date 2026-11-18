import { z } from 'zod';
export { ConfirmBodySchema, RejectBodySchema, ReviseBodySchema } from './reminder/schemas.js';
export {
  ApprovalDetailSchema,
  DocumentApprovalDetailSchema,
  DocumentApprovalConfirmBodySchema,
  DocumentApprovalRejectBodySchema,
  DocumentApprovalActionResultSchema,
} from '@along/contracts';
export const ApprovalListSchema = z.object({
  items: z.array(
    z.object({
      approval_id: z.string(),
      title: z.string(),
      status: z.string(),
      expires_at: z.string(),
      created_at: z.string(),
    }),
  ),
  next_cursor: z.string().nullable(),
});
export const ConfirmResultSchema = z.object({
  approval_id: z.string(),
  status: z.literal('consumed'),
  task_id: z.string(),
  duplicate: z.boolean(),
});
export const RejectResultSchema = z.object({
  approval_id: z.string(),
  status: z.literal('rejected'),
  duplicate: z.boolean(),
});
export const ReviseResultSchema = z.object({
  approval_id: z.string(),
  successor_approval_id: z.string(),
  duplicate: z.boolean(),
});
