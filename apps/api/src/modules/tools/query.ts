import type { PoolClient } from 'pg';
import { workspaceGrantSchema } from '@along/contracts';
import { readDocumentApprovalReceipt } from '../approvals/decision.js';
import { assertToolRunBinding } from '../conversations/tool-binding.js';
import type { DocumentRunEvidence } from '../approvals/document-evidence.js';
import type { ToolContext } from './contracts.js';
import { parseResult } from './result-schema.js';

type RunBinding = Pick<ToolContext, 'ownerId' | 'conversationId' | 'runId'>;

// This is the only document-effect projection. Approvals/conversations consume
// explicit accepted facts rather than reaching into the tools result ledger.
export async function readRunDocumentEvidence(
  client: PoolClient,
  binding: RunBinding,
): Promise<DocumentRunEvidence> {
  await assertToolRunBinding(client, binding);
  const { rows } = await client.query<{
    invocation_id: string;
    owner_id: string;
    conversation_id: string;
    run_id: string;
    tool_id: string;
    state: 'reserved' | 'unknown' | 'completed';
    approval_id: string | null;
    frozen_context: { workspaceGrant?: unknown; documentApprovalId?: string };
    accepted_result: unknown;
    created_at: string;
    accepted_at: string;
  }>(
    `SELECT invocation_id,owner_id,conversation_id,run_id,tool_id,state,approval_id,
      frozen_context,accepted_result,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      coalesce(to_char(accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'') AS accepted_at
     FROM tool_invocations
     WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
       AND tool_id IN ('workspace_read','workspace_apply_replace')
     ORDER BY created_at,invocation_id`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  const reads: DocumentRunEvidence['reads'][number][] = [];
  const applies: DocumentRunEvidence['applies'][number][] = [];
  for (const row of rows) {
    const grant = workspaceGrantSchema.parse(row.frozen_context.workspaceGrant);
    const identity = {
      invocation_id: row.invocation_id,
      owner_id: row.owner_id,
      conversation_id: row.conversation_id,
      run_id: row.run_id,
      workspace_id: grant.workspace_id,
      registration_digest: grant.registration_digest,
      created_at: row.created_at,
      accepted_at: row.accepted_at,
    };
    if (row.tool_id === 'workspace_read') {
      if (row.state !== 'completed') continue;
      const accepted = parseResult(row.accepted_result);
      if (accepted.status === 'ok' && accepted.result.kind === 'read')
        reads.push({
          ...identity,
          kind: 'read',
          relative_path: accepted.result.path,
          result: accepted.result,
        });
      continue;
    }
    const approvalId = row.frozen_context.documentApprovalId;
    if (!approvalId) continue;
    const receipt = await readDocumentApprovalReceipt(client, binding.ownerId, approvalId);
    const accepted = row.state === 'completed' ? parseResult(row.accepted_result) : null;
    const result =
      accepted?.status === 'ok' &&
      (accepted.result.kind === 'applied' || accepted.result.kind === 'conflict')
        ? accepted.result
        : null;
    applies.push({
      ...identity,
      kind: 'apply',
      relative_path: receipt.relative_path,
      approval_id: approvalId,
      state: row.state,
      result,
    });
  }
  return { reads, applies };
}
