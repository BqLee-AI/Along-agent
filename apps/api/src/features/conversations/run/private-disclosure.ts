import type { PoolClient } from 'pg';
import type { ThreadEvent } from '@along/stream-protocol';
import {
  feishuBotDocxGrantSchema,
  loadFeishuBotDocxConfiguration,
  matchFeishuBotDocxGrant,
  readFeishuBotObservationKey,
} from '../../office-connectors/public.js';
import { assertOfficeSources, readOfficeObservationKey } from '../../native-office/public.js';
import { ApplicationError } from '../../../platform/errors.js';

/** Shared legacy marker for Feishu and office events awaiting an authorized handoff. */
export async function stagePrivateDisclosure(client: PoolClient, event: ThreadEvent) {
  await client.query(
    `INSERT INTO feishu_pending_disclosures (run_id,event_seq,is_terminal)
     VALUES ($1,$2,$3)`,
    [event.payload.run_id, event.seq, event.type !== 'message.delta'],
  );
}

export async function releasePrivateDisclosure(client: PoolClient, event: ThreadEvent) {
  await client.query('DELETE FROM feishu_pending_disclosures WHERE run_id=$1 AND event_seq=$2', [
    event.payload.run_id,
    event.seq,
  ]);
}

export async function hasPendingPrivateTerminal(client: PoolClient, runId: string) {
  return !!(
    await client.query(
      'SELECT 1 FROM feishu_pending_disclosures WHERE run_id=$1 AND is_terminal LIMIT 1',
      [runId],
    )
  ).rowCount;
}

/** Check first delivery under the same binding lock used by disconnect. */
export async function privateDisclosureAccess(
  client: PoolClient,
  ownerId: string,
  sessionId: string | null,
  event: ThreadEvent,
): Promise<'public' | 'allowed' | 'withhold'> {
  const pending = await client.query<{ grant: unknown; office: boolean; conversationId: string }>(
    `SELECT r.frozen_context->'feishuDocx' AS grant,
            r.frozen_context ? 'officeMaterials' AS office,
            r.conversation_id AS "conversationId"
     FROM feishu_pending_disclosures p JOIN agent_runs r ON r.id=p.run_id
     WHERE p.run_id=$1 AND p.event_seq=$2 AND r.owner_id=$3 FOR UPDATE OF p`,
    [event.payload.run_id, event.seq, ownerId],
  );
  if (!pending.rows[0]) return 'public';
  if (!sessionId) return 'withhold';
  if (pending.rows[0].office) {
    if (!readOfficeObservationKey()) return 'withhold';
    try {
      await assertOfficeSources(client, {
        ownerId,
        conversationId: pending.rows[0].conversationId,
        runId: event.payload.run_id,
        sourceAttachmentIds: null,
      });
      return 'allowed';
    } catch (error) {
      if (error instanceof ApplicationError && error.errorCode === 'NOT_FOUND') return 'withhold';
      throw error;
    }
  }
  const grant = feishuBotDocxGrantSchema.safeParse(pending.rows[0].grant);
  const config = loadFeishuBotDocxConfiguration();
  return grant.success &&
    config &&
    readFeishuBotObservationKey(config) &&
    (await matchFeishuBotDocxGrant(client, config, { ownerId, sessionId }, grant.data))
    ? 'allowed'
    : 'withhold';
}
