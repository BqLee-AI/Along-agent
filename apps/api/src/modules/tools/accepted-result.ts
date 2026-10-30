import type { PoolClient } from 'pg';
import { z } from 'zod';
import { stateConflict } from '../../http/errors.js';
import { readDocumentApprovalReceipt } from '../approvals/decision.js';
import { readFrozenToolApproval } from '../approvals/tool-result.js';
import type { ToolContext, ToolResult } from './contracts.js';
import { approvalReceiptSchema, parseResult, resultKind } from './result-schema.js';

const documentReceiptSchema = z
  .object({
    kind: z.literal('document_approval_receipt'),
    approval_id: z.string().uuid(),
    presentation_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

// Accepted-fact hydration is shared by read-side projections and execution replay.
// No Run locks, invocation writes, effect dispatch, or mutable approval status.
export async function readAcceptedInvocationResult(
  client: PoolClient,
  ctx: Pick<ToolContext, 'ownerId' | 'runId'>,
  row: {
    result_version: number | null;
    tool_id: string;
    approval_id: string | null;
    accepted_result?: unknown;
    outcome_kind: string | null;
  },
): Promise<ToolResult> {
  if (row.result_version !== 1) throw stateConflict('unsupported tool result version');
  if (row.approval_id && row.tool_id === 'workspace_propose_replace') {
    const receipt = documentReceiptSchema.parse(row.accepted_result);
    if (receipt.approval_id !== row.approval_id)
      throw stateConflict('document receipt reference conflict');
    const approval = await readDocumentApprovalReceipt(client, ctx.ownerId, row.approval_id);
    if (approval.presentation_hash !== receipt.presentation_hash || approval.run_id !== ctx.runId)
      throw stateConflict('document receipt differs from frozen approval');
    return { status: 'ok', result: { kind: 'document_approval', approval } };
  }
  if (row.approval_id && row.tool_id !== 'workspace_apply_replace') {
    const receipt = approvalReceiptSchema.parse(row.accepted_result);
    if (receipt.approvalId !== row.approval_id)
      throw stateConflict('approval result reference conflict');
    return {
      status: 'ok',
      result: await readFrozenToolApproval(client, { ownerId: ctx.ownerId, ...receipt }),
    };
  }
  const result = parseResult(row.accepted_result);
  if (result.status === 'unknown' || resultKind(result) !== row.outcome_kind)
    throw stateConflict('invalid accepted tool result');
  return result;
}
