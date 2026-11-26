import type { Pool } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { forbidden, stateConflict } from '../../platform/errors.js';
import { requirePersonalBot } from '../bots/public.js';
import { lockViewerAccess, type Actor } from '../identity/public.js';

export async function createBotConversation(pool: Pool, actor: Actor, botId: string, key: string) {
  const { ownerId, sessionId } = actor;
  return withTransaction(pool, async (client) => {
    if (!(await lockViewerAccess(client, ownerId, sessionId)))
      throw forbidden('owner authorization revoked');
    await requirePersonalBot(client, ownerId, botId);

    // The key is owner-wide; serializing it also orders attempts from different Bots.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `bot-conversation:${ownerId}:${key.toLowerCase()}`,
    ]);
    const replay = await client.query<{ conversation_id: string; bot_id: string }>(
      `SELECT c.id AS conversation_id, c.bot_id FROM bot_conversation_requests r
       JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
       WHERE r.owner_id=$1 AND r.idempotency_key=$2 AND r.expires_at > clock_timestamp()`,
      [ownerId, key],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].bot_id !== botId)
        throw stateConflict('idempotency key reused for a different Bot');
      return { conversation_id: replay.rows[0].conversation_id };
    }

    await client.query(
      'DELETE FROM bot_conversation_requests WHERE owner_id=$1 AND idempotency_key=$2',
      [ownerId, key],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO conversations (id, owner_id, bot_id)
       VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
      [ownerId, botId],
    );
    const conversationId = rows[0]!.id;
    await client.query(
      `INSERT INTO bot_conversation_requests (owner_id,idempotency_key,conversation_id,expires_at)
       VALUES ($1,$2,$3,clock_timestamp() + interval '24 hours')`,
      [ownerId, key, conversationId],
    );
    return { conversation_id: conversationId };
  });
}
