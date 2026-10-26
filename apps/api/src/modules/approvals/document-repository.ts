import type { PoolClient } from 'pg';
import type { DocumentApprovalReceipt, WorkspaceGrant } from '@along/contracts';
import { forbidden, notFound } from '../../http/errors.js';

export interface DocumentApprovalRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  run_id: string;
  workspace_id: string;
  workspace_grant: WorkspaceGrant;
  relative_path: string;
  base_read_invocation_id: string;
  base_version: string;
  exact_new_content: string;
  new_version: string;
  presentation_version: 'document_replace.v1';
  presentation_hash: string;
  preview: DocumentApprovalReceipt['preview'];
  state: 'pending' | 'approved' | 'rejected';
  apply_invocation_id: string | null;
  replaces_approval_id: string | null;
}
export async function getDocumentApproval(
  client: PoolClient,
  ownerId: string,
  id: string,
  lock = false,
): Promise<DocumentApprovalRow> {
  const row = (
    await client.query<DocumentApprovalRow>(
      `SELECT * FROM document_approvals WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )
  ).rows[0];
  if (!row) throw notFound('document approval not found');
  if (row.owner_id !== ownerId) throw forbidden('document approval not found');
  return row;
}
export async function listDocumentApprovals(
  client: PoolClient,
  ownerId: string,
  conversationId: string,
  runId: string,
): Promise<DocumentApprovalRow[]> {
  return (
    await client.query<DocumentApprovalRow>(
      'SELECT * FROM document_approvals WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3 ORDER BY created_at,id',
      [ownerId, conversationId, runId],
    )
  ).rows;
}
