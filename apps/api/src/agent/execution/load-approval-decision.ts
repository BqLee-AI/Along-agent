import type { PoolClient } from 'pg';
import type { HarnessApprovalDecision } from '@along/contracts';
import { stateConflict } from '../../platform/errors.js';
import {
  readApprovalDecision,
  readDocumentApprovalDecision,
} from '../../features/approvals/public.js';
import { readRunInvocationStates } from '../tools/invocations/run-state.js';

// Approval storage selection comes only from tools' immutable invocation
// projection, never from a native kind claim or an untrusted approval UUID.
export async function readRunApprovalDecision(
  client: PoolClient,
  binding: { ownerId: string; conversationId: string; runId: string },
  invocationId: string,
  approvalId: string,
): Promise<HarnessApprovalDecision> {
  const states = await readRunInvocationStates(client, binding);
  const row = states.find((state) => state.invocation_id === invocationId);
  if (
    row?.state !== 'completed' ||
    row.outcome_kind !== 'approval_pending' ||
    !row.approval_ref ||
    row.approval_ref.approval_id !== approvalId
  )
    throw stateConflict('invalid trusted approval invocation reference');
  if (row.approval_ref.kind === 'document') {
    if (row.tool_id !== 'workspace_propose_replace')
      throw stateConflict('document approval tool mismatch');
    const { run_id, ...decision } = await readDocumentApprovalDecision(
      client,
      binding.ownerId,
      approvalId,
    );
    if (run_id !== binding.runId) throw stateConflict('document approval Run mismatch');
    return decision;
  }
  if (row.tool_id !== 'propose_task' && row.tool_id !== 'request_cancel_task')
    throw stateConflict('task approval tool mismatch');
  return readApprovalDecision(client, binding.ownerId, approvalId);
}
