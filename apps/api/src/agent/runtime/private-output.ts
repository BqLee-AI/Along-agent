import type { PoolClient } from 'pg';
import { requireCurrentFeishuBotAuthority } from '../tools/invocations/accepted-result.js';
import { assertOfficeSources } from '../../features/native-office/public.js';
import { lockViewerAccess } from '../../features/identity/public.js';
import { forbidden } from '../../platform/errors.js';
import { requireOfficeKey } from '../tools/office/authority.js';
import type { RunContext } from './contracts.js';

export async function hasPrivateOutput(
  client: PoolClient,
  context: Pick<RunContext, 'ownerId' | 'conversationId' | 'runId'>,
): Promise<boolean> {
  const receipt = await client.query(
    `SELECT 1 FROM office_run_materials
      WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3
     UNION ALL
     SELECT 1 FROM tool_invocations
      WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3 AND tool_id='feishu_docx_read'
        AND state='completed' AND outcome_kind='success' LIMIT 1`,
    [context.ownerId, context.conversationId, context.runId],
  );
  return !!receipt.rowCount;
}

/** Model output may quote any private source even without a citation. */
export async function authorizePrivateOutput(client: PoolClient, context: RunContext) {
  const office = await client.query(
    'SELECT 1 FROM office_run_materials WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3',
    [context.ownerId, context.conversationId, context.runId],
  );
  if (office.rowCount) {
    requireOfficeKey();
    if (
      !context.officeSessionId ||
      !(await lockViewerAccess(client, context.ownerId, context.officeSessionId))
    )
      throw forbidden('office session authorization revoked');
    await assertOfficeSources(client, { ...context, sourceAttachmentIds: null });
    return true;
  }
  if (!context.feishuDocx || !(await hasPrivateOutput(client, context))) return false;
  await requireCurrentFeishuBotAuthority(client, context);
  return true;
}
