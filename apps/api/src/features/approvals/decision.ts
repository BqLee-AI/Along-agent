import type { PoolClient } from 'pg';
import { ApprovalStatusSchema, HarnessApprovalDecisionSchema } from '@along/contracts';
import type {
  ApprovalStatus,
  DocumentApprovalDecision,
  DocumentApprovalReceipt,
  HarnessApprovalDecision,
} from '@along/contracts';
import { forbidden, notFound, stateConflict } from '../../platform/errors.js';
import { effectiveStatus, readApprovalFacts } from './reminder/repository.js';
import type { ApprovalReadRow } from './reminder/repository.js';
import { getDocumentApproval } from './document/document-query.js';
import { documentReceipt } from './document/document-rules.js';

export interface ApprovalReadProjection {
  row: ApprovalReadRow;
  status: ApprovalStatus;
  taskId: string | null;
  successorId: string | null;
}

// Public read projection: no confirmation, expiry mutation, or frozen-result guess.
// Stored facts and effective time are read once, including the successor link.
export async function readApprovalProjection(
  client: PoolClient,
  ownerId: string,
  approvalId: string,
  now?: Date,
): Promise<ApprovalReadProjection> {
  const row = await readApprovalFacts(client, approvalId, now);
  if (!row) throw notFound('approval not found');
  if (row.owner_id !== ownerId) throw forbidden('approval not found');
  const status = ApprovalStatusSchema.parse(effectiveStatus(row, row.effective_now));
  const taskId =
    status === 'consumed'
      ? row.kind === 'cancel_task'
        ? row.target_task_id
        : row.consumed_task_id
      : null;
  if (status === 'consumed' && !taskId) throw stateConflict('consumed approval has no task result');
  return {
    row,
    status,
    taskId,
    successorId: status === 'superseded' ? row.successor_approval_id : null,
  };
}

// The caller may share a transaction with Run authority; no extra connection opens.
export async function readApprovalDecision(
  client: PoolClient,
  ownerId: string,
  approvalId: string,
): Promise<HarnessApprovalDecision> {
  const projection = await readApprovalProjection(client, ownerId, approvalId);
  return HarnessApprovalDecisionSchema.parse({
    kind: 'task',
    approval_id: projection.row.id,
    status: projection.status,
    task_id: projection.taskId,
    successor_id: projection.successorId,
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
