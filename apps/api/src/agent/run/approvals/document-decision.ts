import type { Pool, PoolClient } from 'pg';
import {
  DocumentApprovalConfirmBodySchema,
  DocumentApprovalRejectBodySchema,
  type DocumentApprovalActionResult,
} from '@along/contracts';
import { withTransaction } from '../../../db/transaction.js';
import { notReady, validationError } from '../../../platform/errors.js';
import {
  decideDocumentApprovalWithinTransaction,
  getDocumentApproval,
} from '../../../features/approvals/public.js';
import { lockDocumentApprovalRun } from '../../../features/conversations/public.js';
import { terminateRejectedDocumentRun } from './reject-document.js';

export async function confirmDocumentApproval(
  deps: { pool: Pool | null },
  ownerId: string,
  approvalId: string,
  body: unknown,
): Promise<DocumentApprovalActionResult> {
  const parsed = DocumentApprovalConfirmBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid document confirm body');
  if (!deps.pool) throw notReady();
  return withTransaction(deps.pool, (client) =>
    decideDocumentApproval(client, ownerId, approvalId, 'confirm', parsed.data),
  );
}

export async function rejectDocumentApproval(
  deps: { pool: Pool | null },
  ownerId: string,
  approvalId: string,
  body: unknown,
): Promise<DocumentApprovalActionResult> {
  const parsed = DocumentApprovalRejectBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid document reject body');
  if (!deps.pool) throw notReady();
  return withTransaction(deps.pool, (client) =>
    decideDocumentApproval(client, ownerId, approvalId, 'reject', parsed.data),
  );
}

async function decideDocumentApproval(
  client: PoolClient,
  ownerId: string,
  approvalId: string,
  action: 'confirm' | 'reject',
  body: {
    idempotency_key: string;
    presentation_hash?: string;
    seen_content?: string;
    reason?: string;
  },
): Promise<DocumentApprovalActionResult> {
  // Locate without locking, then retain attempt -> Run -> approval lock order.
  const located = await getDocumentApproval(client, ownerId, approvalId);
  const authority = await lockDocumentApprovalRun(client, {
    ownerId,
    conversationId: located.conversation_id,
    runId: located.run_id,
    workspaceGrant: located.workspace_grant,
  });
  const { result, conversationId, runId } = await decideDocumentApprovalWithinTransaction(
    client,
    ownerId,
    approvalId,
    action,
    authority.canAuthorize,
    body,
  );
  if (action === 'reject' && !result.duplicate) {
    await terminateRejectedDocumentRun(client, {
      ownerId,
      conversationId,
      runId,
      approvalId,
      requestId: body.idempotency_key,
    });
  }
  return result;
}
