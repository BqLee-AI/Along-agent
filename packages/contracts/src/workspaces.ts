import { z } from 'zod';

export const workspaceSummarySchema = z
  .object({
    workspace_id: z.string().min(1),
    label: z.string().min(1),
    readable_paths: z.array(z.string()),
    writable_paths: z.array(z.string()),
  })
  .strict();
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export const workspaceGrantSchema = z
  .object({
    workspace_id: z.string().min(1),
    owner_id: z.string().min(1),
    registration_digest: z.string().regex(/^[a-f0-9]{64}$/),
    root_identity: z.string().min(1),
  })
  .strict();
export type WorkspaceGrant = z.infer<typeof workspaceGrantSchema>;
export const workspaceOperationErrorSchema = z
  .object({
    kind: z.literal('operation_error'),
    path: z.string(),
    workspace_id: z.string().min(1).optional(),
    reason: z.enum([
      'not_found',
      'unreadable',
      'invalid_utf8',
      'range_too_large',
      'literal_not_found',
      'literal_not_unique',
      'unchanged',
      'version_changed',
      'unsupported_source',
    ]),
  })
  .strict();
export const workspaceReadResultSchema = z
  .object({
    kind: z.literal('read'),
    workspace_id: z.string().min(1).optional(),
    path: z.string(),
    version: z.string().regex(/^[a-f0-9]{64}$/),
    byte_length: z.number().int().nonnegative(),
    content: z.string(),
  })
  .strict();
export const workspaceListResultSchema = z
  .object({
    kind: z.literal('list'),
    workspace_id: z.string().min(1).optional(),
    path: z.string(),
    entries: z.array(z.object({ path: z.string(), kind: z.enum(['file', 'directory']) }).strict()),
    failures: z.array(workspaceOperationErrorSchema),
  })
  .strict();
export const workspaceSearchResultSchema = z
  .object({
    kind: z.literal('search'),
    workspace_id: z.string().min(1).optional(),
    path: z.string(),
    matches: z.array(
      z
        .object({
          path: z.string(),
          line: z.number().int().positive(),
          text: z.string(),
          version: z.string(),
        })
        .strict(),
    ),
    failures: z.array(workspaceOperationErrorSchema),
  })
  .strict();
export const workspaceAppliedResultSchema = z
  .object({
    kind: z.literal('applied'),
    workspace_id: z.string(),
    path: z.string(),
    approval_id: z.string().uuid(),
    invocation_id: z.string().uuid(),
    args_hash: z.string(),
    base_version: z.string(),
    version: z.string(),
    byte_length: z.number().int().nonnegative(),
    evidence_ref: z.string(),
  })
  .strict();
export const workspaceConflictResultSchema = z
  .object({
    kind: z.literal('conflict'),
    workspace_id: z.string(),
    path: z.string(),
    approval_id: z.string().uuid(),
    invocation_id: z.string().uuid(),
    args_hash: z.string(),
    base_version: z.string(),
    actual_version: z.string().nullable(),
    reason: z.enum(['version_changed', 'identity_changed', 'not_found', 'unreadable']),
    zero_write: z.literal(true),
  })
  .strict();

export const workspaceEditAppliedResultSchema = workspaceAppliedResultSchema
  .omit({ approval_id: true, kind: true })
  .extend({ kind: z.literal('edit_applied') });
export const workspaceEditConflictResultSchema = workspaceConflictResultSchema
  .omit({ approval_id: true, kind: true })
  .extend({ kind: z.literal('edit_conflict') });

const contextIndex = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const contextSliceIdentity = {
  kind: z.literal('context_slice'),
  source_invocation_id: z.string().uuid(),
  source_tool_id: z.string().min(1),
  workspace_id: z.string().min(1).optional(),
  source_result_version: z.literal(1),
  offset: contextIndex,
  end: contextIndex,
  total: contextIndex,
  has_more: z.boolean(),
};
export const contextSliceResultSchema = z
  .union([
    z
      .object({
        ...contextSliceIdentity,
        source_kind: z.literal('read'),
        field: z.literal('content'),
        unit: z.literal('unicode_scalar'),
        path: z.string(),
        version: z.string().regex(/^[a-f0-9]{64}$/),
        byte_length: contextIndex,
        content: z.string(),
      })
      .strict(),
    z
      .object({
        ...contextSliceIdentity,
        source_kind: z.literal('search'),
        field: z.literal('matches'),
        unit: z.literal('items'),
        items: workspaceSearchResultSchema.shape.matches,
      })
      .strict(),
    z
      .object({
        ...contextSliceIdentity,
        source_kind: z.literal('list'),
        field: z.literal('entries'),
        unit: z.literal('items'),
        items: workspaceListResultSchema.shape.entries,
      })
      .strict(),
    z
      .object({
        ...contextSliceIdentity,
        source_kind: z.enum(['list', 'search']),
        field: z.literal('failures'),
        unit: z.literal('items'),
        items: z.array(workspaceOperationErrorSchema),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    const length = 'content' in value ? Array.from(value.content).length : value.items.length;
    if (
      value.end < value.offset ||
      value.end - value.offset !== length ||
      (value.offset < value.total && value.end === value.offset) ||
      value.has_more !== value.end < value.total ||
      (value.offset < value.total && value.end > value.total) ||
      (value.offset >= value.total && (value.end !== value.offset || value.has_more))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid context slice range' });
    if (
      'content' in value &&
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value.content)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Unicode scalar content' });
  });
export type ContextSliceResult = z.infer<typeof contextSliceResultSchema>;
export const workspaceResultSchema = z.union([
  workspaceListResultSchema,
  workspaceSearchResultSchema,
  workspaceReadResultSchema,
  workspaceAppliedResultSchema,
  workspaceOperationErrorSchema,
  workspaceConflictResultSchema,
  workspaceEditAppliedResultSchema,
  workspaceEditConflictResultSchema,
  contextSliceResultSchema,
]);
export type WorkspaceReadResult = z.infer<typeof workspaceReadResultSchema>;
export type WorkspaceOperationError = z.infer<typeof workspaceOperationErrorSchema>;
export type WorkspaceResult = z.infer<typeof workspaceResultSchema>;
export type WorkspaceAppliedResult = z.infer<typeof workspaceAppliedResultSchema>;
export type WorkspaceConflictResult = z.infer<typeof workspaceConflictResultSchema>;
