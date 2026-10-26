import type { PoolClient } from 'pg';
import {
  HarnessApprovalDecisionSchema,
  type DocumentApprovalDecision,
  type DocumentApprovalReceipt,
  type HarnessApprovalDecision,
} from '@along/contracts';
import { forbidden, notFound, stateConflict } from '../../http/errors.js';
import { getApproval, effectiveStatus, findSuccessorId } from './repository.js';
import { getDocumentApproval } from './document-repository.js';
import { documentReceipt } from './document-rules.js';

// Public read projection: no confirmation, expiry mutation, or frozen-result guess.
// The caller may share a transaction with Run authority; no extra connection opens.
export async function readApprovalDecision(
  client: PoolClient,
  ownerId: string,
  approvalId: string,
): Promise<HarnessApprovalDecision> {
  const found = await getApproval(client, ownerId, approvalId);
  if (!found.found) throw notFound('approval not found');
  if (found.forbidden) throw forbidden('approval not found');
  const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const now = clock.rows[0]?.now;
  if (!now) throw new Error('database clock unavailable');
  const row = found.row;
  const status = effectiveStatus(row, now);
  const taskId =
    status === 'consumed'
      ? row.kind === 'cancel_task'
        ? row.target_task_id
        : row.consumed_task_id
      : null;
  if (status === 'consumed' && !taskId) throw stateConflict('consumed approval has no task result');
  return HarnessApprovalDecisionSchema.parse({
    kind: 'task',
    approval_id: row.id,
    status,
    task_id: taskId,
    successor_id: status === 'superseded' ? await findSuccessorId(client, row.id) : null,
  });
}

export async function readDocumentApprovalReceipt(
  client: PoolClient,
  ownerId: string,
  approvalId: string,
): Promise<DocumentApprovalReceipt> {
  return documentReceipt(await getDocumentApproval(client, ownerId, approvalId));
}
export async function readDocumentApprovalDecision(
  client: PoolClient,
  ownerId: string,
  approvalId: string,
): Promise<DocumentApprovalDecision> {
  const row = await getDocumentApproval(client, ownerId, approvalId);
  return {
    kind: 'document',
    approval_id: row.id,
    run_id: row.run_id,
    status: row.state,
    apply_invocation_id: row.apply_invocation_id,
  };
}
