import type { PoolClient } from 'pg';
import type { ThreadEvent } from '@along/stream-protocol';
import { stagePrivateDisclosure } from '../../../features/conversations/public.js';
import { requireCurrentFeishuBotAuthority } from '../../tools/invocations/accepted-result.js';
import type { RunContext } from '../contracts.js';

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

/** Persist under the caller's attempt fence; delivery rechecks authority separately. */
export async function persistAttemptOutput(
  client: PoolClient,
  context: RunContext,
  writeEvent: () => Promise<ThreadEvent>,
  mayDisclosePrivateOutput = true,
) {
  const privateOutput = mayDisclosePrivateOutput && (await authorizePrivateOutput(client, context));
  const event = await writeEvent();
  if (privateOutput) await stagePrivateDisclosure(client, event);
  return { event, privateOutput };
}
