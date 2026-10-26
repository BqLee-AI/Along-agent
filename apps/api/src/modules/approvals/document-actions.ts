import type { Pool, PoolClient } from 'pg';
import {
  DocumentApprovalConfirmBodySchema,
  DocumentApprovalRejectBodySchema,
  type DocumentApprovalActionResult,
} from '@along/contracts';
import { withTransaction } from '../../db/transaction.js';
import {
  notReady,
  presentationMismatch,
  stateConflict,
  validationError,
} from '../../http/errors.js';
import { lockDocumentApprovalRun } from '../conversations/tool-binding.js';
import { validateWorkspaceGrant } from '../workspaces/service.js';
import { getDocumentApproval } from './document-repository.js';
import { buildDocumentPresentation, documentContentVersion } from './document-rules.js';

interface DecisionRow {
  target_approval_id: string;
  action: 'confirm' | 'reject';
  request_hash: string;
  decision: 'approved' | 'rejected';
}
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
  // A nonlocking lookup locates authority; never acquire Run after approval.
  const located = await getDocumentApproval(client, ownerId, approvalId);
  const authority = await lockDocumentApprovalRun(client, {
    ownerId,
    conversationId: located.conversation_id,
    runId: located.run_id,
  });
  const row = await getDocumentApproval(client, ownerId, approvalId, true);
  const requestHash = documentContentVersion(
    JSON.stringify({
      action,
      approval_id: approvalId,
      ...(action === 'confirm'
        ? { presentation_hash: body.presentation_hash, seen_content: body.seen_content }
        : body.reason === undefined
          ? {}
          : { reason: body.reason }),
    }),
  );
  const previous = (
    await client.query<DecisionRow>(
      'SELECT target_approval_id,action,request_hash,decision FROM document_approval_decisions WHERE owner_id=$1 AND idempotency_key=$2',
      [ownerId, body.idempotency_key],
    )
  ).rows[0];
  if (previous) {
    if (
      previous.target_approval_id !== approvalId ||
      previous.action !== action ||
      previous.request_hash !== requestHash
    )
      throw stateConflict('document decision idempotency key is bound to a different request');
    return { approval_id: approvalId, status: previous.decision, duplicate: true };
  }
  if (action === 'confirm') {
    const frozen = buildDocumentPresentation({
      workspace_id: row.workspace_id,
      relative_path: row.relative_path,
      base_version: row.base_version,
      new_version: row.new_version,
      before: row.preview.before,
      exact_new_content: row.exact_new_content,
    });
    if (
      row.presentation_version !== frozen.presentation_version ||
      row.presentation_hash !== frozen.presentation_hash ||
      row.preview.body !== frozen.preview.body ||
      row.preview.after !== row.exact_new_content ||
      documentContentVersion(row.exact_new_content) !== row.new_version ||
      documentContentVersion(row.preview.before) !== row.base_version ||
      body.presentation_hash !== row.presentation_hash ||
      body.seen_content !== row.preview.body
    )
      throw presentationMismatch();
  }
  const decision = action === 'confirm' ? ('approved' as const) : ('rejected' as const);
  if (row.state !== 'pending' && row.state !== decision)
    throw stateConflict('document approval decision is final');
  const duplicate = row.state === decision;
  // Replays may return historical authorization, but terminal/cancelled Runs
  // must never grant a new one. Rejection also follows the live authority gate.
  if (!duplicate) {
    if (!authority.canAuthorize) throw stateConflict('document approval Run is not live');
    validateWorkspaceGrant(ownerId, row.workspace_grant);
  }
  // Unique owner/key is the cross-target concurrency arbiter. ON CONFLICT waits
  // without needing locks on another approval, avoiding lock-order inversion.
  const inserted = await client.query(
    `INSERT INTO document_approval_decisions
    (owner_id,idempotency_key,target_approval_id,action,request_hash,decision)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (owner_id,idempotency_key) DO NOTHING RETURNING idempotency_key`,
    [ownerId, body.idempotency_key, approvalId, action, requestHash, decision],
  );
  if (inserted.rowCount !== 1) {
    const raced = (
      await client.query<DecisionRow>(
        'SELECT target_approval_id,action,request_hash,decision FROM document_approval_decisions WHERE owner_id=$1 AND idempotency_key=$2',
        [ownerId, body.idempotency_key],
      )
    ).rows[0];
    if (
      !raced ||
      raced.target_approval_id !== approvalId ||
      raced.action !== action ||
      raced.request_hash !== requestHash
    )
      throw stateConflict('document decision idempotency key is bound to a different request');
    return { approval_id: approvalId, status: raced.decision, duplicate: true };
  }
  if (!duplicate)
    await client.query('UPDATE document_approvals SET state=$2 WHERE id=$1', [
      approvalId,
      decision,
    ]);
  return { approval_id: approvalId, status: decision, duplicate };
}
