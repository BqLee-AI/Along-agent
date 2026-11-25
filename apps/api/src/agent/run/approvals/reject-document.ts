import type { PoolClient } from 'pg';
import { stateConflict } from '../../../platform/errors.js';
import {
  latestAttemptId,
  lockRun,
  readLatestAttemptSnapshotId,
} from '../../../features/conversations/public.js';
import { commitTerminal } from '../../execution/result/commit.js';
import { readRunApprovalDecision } from '../../execution/load-approval-decision.js';
import { readSnapshot } from '../../execution/attempt/restore-snapshot.js';

// The approval decision and this transition share the caller's transaction.
// The caller already holds attempt -> Run -> approval; re-locking the same rows
// here only recovers the current Run snapshot, without introducing a new order.
export async function terminateRejectedDocumentRun(
  client: PoolClient,
  binding: {
    ownerId: string;
    conversationId: string;
    runId: string;
    approvalId: string;
    requestId: string;
  },
): Promise<void> {
  const attemptId = await latestAttemptId(client, binding.ownerId, binding.runId);
  const { run, attempt } = await lockRun(client, { ...binding, attemptId }, false, false);
  if (
    run.execution !== 'harness' ||
    run.frozen_context?.authorization_revision !== 'delegation/1' ||
    run.status !== 'suspended_approval' ||
    run.waiting_approval_id !== binding.approvalId ||
    !run.waiting_checkpoint_id ||
    !run.waiting_invocation_id
  )
    return;

  if ((await readLatestAttemptSnapshotId(client, attempt.id)) !== run.waiting_checkpoint_id)
    throw stateConflict('approval waiting checkpoint is not current');
  const used = await client.query('SELECT 1 FROM harness_resumes WHERE checkpoint_id=$1', [
    run.waiting_checkpoint_id,
  ]);
  if (used.rowCount) throw stateConflict('approval waiting point already resumed');
  const snapshot = await readSnapshot(client, run, run.waiting_checkpoint_id);
  if (
    snapshot.waiting?.invocation_id !== run.waiting_invocation_id ||
    snapshot.waiting.approval_id !== binding.approvalId
  )
    throw stateConflict('waiting checkpoint reference conflict');
  const decision = await readRunApprovalDecision(
    client,
    binding,
    run.waiting_invocation_id,
    binding.approvalId,
  );
  if (decision.kind !== 'document' || decision.status !== 'rejected')
    throw stateConflict('waiting point is not the rejected document approval');

  await commitTerminal(
    client,
    { ...binding, attemptId: attempt.id },
    'cancelled',
    {
      conversation_id: binding.conversationId,
      run_id: binding.runId,
      reason: 'document_approval_rejected',
    },
    { preserveAttemptStatus: true },
  );
}
