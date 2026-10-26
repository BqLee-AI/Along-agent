import { z } from 'zod';

const Id = z.string().uuid();
const Version = z.string().regex(/^[0-9a-f]{64}$/);
export const DocumentApprovalStateSchema = z.enum(['pending', 'approved', 'rejected']);
export const DocumentApprovalReceiptSchema = z
  .object({
    kind: z.literal('document_replace'),
    approval_id: Id,
    run_id: Id,
    conversation_id: Id,
    workspace_id: z.string().min(1),
    relative_path: z.string().min(1),
    base_read_invocation_id: Id,
    base_version: Version,
    new_version: Version,
    exact_new_content: z.string(),
    presentation_version: z.literal('document_replace.v1'),
    presentation_hash: Version,
    preview: z.object({ before: z.string(), after: z.string(), body: z.string() }).strict(),
    replaces_approval_id: Id.nullable(),
  })
  .strict();
export type DocumentApprovalReceipt = z.infer<typeof DocumentApprovalReceiptSchema>;

export const DocumentApprovalDecisionSchema = z
  .object({
    kind: z.literal('document'),
    approval_id: Id,
    run_id: Id,
    status: DocumentApprovalStateSchema,
    apply_invocation_id: Id.nullable(),
  })
  .strict();
export type DocumentApprovalDecision = z.infer<typeof DocumentApprovalDecisionSchema>;

export const DocumentApprovalEffectSchema = z
  .object({
    status: z.enum([
      'not_started',
      'reserved',
      'unknown',
      'failed',
      'conflict',
      'applied',
      'verified',
    ]),
    apply_invocation_id: Id.nullable(),
    read_invocation_id: Id.nullable(),
    successor_approval_id: Id.nullable(),
  })
  .strict();
export type DocumentApprovalEffect = z.infer<typeof DocumentApprovalEffectSchema>;

export const DocumentApprovalDetailSchema = DocumentApprovalReceiptSchema.extend({
  state: DocumentApprovalStateSchema,
  apply_invocation_id: Id.nullable(),
  effect: DocumentApprovalEffectSchema,
});
export type DocumentApprovalDetail = z.infer<typeof DocumentApprovalDetailSchema>;

export const DocumentApprovalActionResultSchema = z
  .object({
    approval_id: Id,
    status: z.enum(['approved', 'rejected']),
    duplicate: z.boolean(),
  })
  .strict();
export type DocumentApprovalActionResult = z.infer<typeof DocumentApprovalActionResultSchema>;

// Document whitespace is content: none of these fields are trimmed or normalized.
export const DocumentApprovalConfirmBodySchema = z
  .object({
    presentation_hash: Version,
    seen_content: z.string(),
    idempotency_key: Id,
  })
  .strict();
export const DocumentApprovalRejectBodySchema = z
  .object({
    idempotency_key: Id,
    reason: z.string().max(2000).optional(),
  })
  .strict();
