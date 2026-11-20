import type { PoolClient } from 'pg';
import { requireCurrentFeishuBotAuthority } from '../tools/invocations/accepted-result.js';
import type { RunContext } from './contracts.js';

export async function hasPrivateOutput(
  client: PoolClient,
  context: Pick<RunContext, 'ownerId' | 'conversationId' | 'runId'>,
): Promise<boolean> {
  const receipt = await client.query(
    `SELECT 1 FROM tool_invocations
      WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3 AND tool_id='feishu_docx_read'
        AND state='completed' AND outcome_kind='success' LIMIT 1`,
    [context.ownerId, context.conversationId, context.runId],
  );
  return !!receipt.rowCount;
}

/** Model output can quote any accepted Docx receipt, even with no explicit citation. */
export async function authorizePrivateOutput(client: PoolClient, context: RunContext) {
  if (!context.feishuDocx || !(await hasPrivateOutput(client, context))) return false;
  await requireCurrentFeishuBotAuthority(client, context);
  return true;
}
