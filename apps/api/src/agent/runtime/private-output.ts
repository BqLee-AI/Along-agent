import type { PoolClient } from 'pg';
import { requireCurrentFeishuBotAuthority } from '../tools/invocations/accepted-result.js';
import type { RunContext } from './contracts.js';

/** A model can quote any accepted Docx receipt, even if the goal does not cite it. */
export async function authorizePrivateOutput(
  client: PoolClient,
  context: RunContext,
): Promise<boolean> {
  // Only admission can give a Run this tool; the frozen grant survives revocation.
  if (!context.feishuDocx) return false;
  const receipt = await client.query(
    `SELECT 1 FROM tool_invocations
      WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3 AND tool_id='feishu_docx_read'
        AND state='completed' AND outcome_kind='success' LIMIT 1`,
    [context.ownerId, context.conversationId, context.runId],
  );
  if (!receipt.rowCount) return false;
  await requireCurrentFeishuBotAuthority(client, context);
  return true;
}
