import type { PoolClient } from 'pg';
import type { ThreadEvent } from '@along/stream-protocol';
import {
  feishuBotDocxGrantSchema,
  loadFeishuBotDocxConfiguration,
  matchFeishuBotDocxGrant,
  readFeishuBotObservationKey,
} from '../../office-connectors/public.js';

/** Pending events remain internal until an authorized sink accepts them. */
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
  sessionId: string,
  event: ThreadEvent,
): Promise<'public' | 'allowed' | 'withhold'> {
  const pending = await client.query<{ grant: unknown }>(
    `SELECT r.frozen_context->'feishuDocx' AS grant
     FROM feishu_pending_disclosures p JOIN agent_runs r ON r.id=p.run_id
     WHERE p.run_id=$1 AND p.event_seq=$2 AND r.owner_id=$3 FOR UPDATE OF p`,
    [event.payload.run_id, event.seq, ownerId],
  );
  if (!pending.rows[0]) return 'public';
  const grant = feishuBotDocxGrantSchema.safeParse(pending.rows[0].grant);
  const config = loadFeishuBotDocxConfiguration();
  return grant.success &&
    config &&
    readFeishuBotObservationKey(config) &&
    (await matchFeishuBotDocxGrant(client, config, { ownerId, sessionId }, grant.data))
    ? 'allowed'
    : 'withhold';
}
