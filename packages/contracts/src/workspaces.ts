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
    reason: z.enum([
      'not_found',
      'unreadable',
      'invalid_utf8',
      'range_too_large',
      'literal_not_found',
      'literal_not_unique',
      'unchanged',
      'version_changed',
    ]),
  })
  .strict();
export const workspaceReadResultSchema = z
  .object({
    kind: z.literal('read'),
    path: z.string(),
    version: z.string().regex(/^[a-f0-9]{64}$/),
    byte_length: z.number().int().nonnegative(),
    content: z.string(),
  })
  .strict();
export const workspaceListResultSchema = z
  .object({
    kind: z.literal('list'),
    path: z.string(),
    entries: z.array(z.object({ path: z.string(), kind: z.enum(['file', 'directory']) }).strict()),
    failures: z.array(workspaceOperationErrorSchema),
  })
  .strict();
export const workspaceSearchResultSchema = z
  .object({
    kind: z.literal('search'),
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
export const workspaceResultSchema = z.union([
  workspaceListResultSchema,
  workspaceSearchResultSchema,
  workspaceReadResultSchema,
  workspaceAppliedResultSchema,
  workspaceOperationErrorSchema,
  workspaceConflictResultSchema,
]);
export type WorkspaceReadResult = z.infer<typeof workspaceReadResultSchema>;
export type WorkspaceOperationError = z.infer<typeof workspaceOperationErrorSchema>;
export type WorkspaceResult = z.infer<typeof workspaceResultSchema>;
export type WorkspaceAppliedResult = z.infer<typeof workspaceAppliedResultSchema>;
export type WorkspaceConflictResult = z.infer<typeof workspaceConflictResultSchema>;
