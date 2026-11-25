import type { Pool, PoolClient } from 'pg';

export interface IdempotencyRow {
  request_hash: string;
  conversation_id: string;
  run_id: string;
}

export async function findIdempotency(
  client: Pick<Pool | PoolClient, 'query'>,
  ownerId: string,
  idempotencyKey: string,
): Promise<IdempotencyRow | null> {
  const { rows } = await client.query<IdempotencyRow>(
    `SELECT request_hash, conversation_id, run_id
     FROM conversation_idempotency
     WHERE owner_id = $1 AND idempotency_key = $2 AND expires_at > now()`,
    [ownerId, idempotencyKey],
  );
  return rows[0] ?? null;
}

// Expired keys are deleted before re-insert so a 24h-later retry with the
// same key starts a fresh run instead of colliding with the stale PK.
export async function deleteExpiredIdempotency(
  client: Pick<Pool | PoolClient, 'query'>,
  ownerId: string,
  idempotencyKey: string,
): Promise<void> {
  await client.query(
    `DELETE FROM conversation_idempotency
     WHERE owner_id = $1 AND idempotency_key = $2 AND expires_at <= now()`,
    [ownerId, idempotencyKey],
  );
}

// Plain insert: a concurrent duplicate raises 23505, which the caller turns
// into a replay of the winning run (first writer wins, no overwrite).
export async function insertIdempotency(
  client: Pick<Pool | PoolClient, 'query'>,
  args: {
    ownerId: string;
    idempotencyKey: string;
    requestHash: string;
    conversationId: string;
    runId: string;
    userMessageId: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO conversation_idempotency (owner_id, idempotency_key,
       request_hash, conversation_id, run_id, user_message_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + interval '24 hours')`,
    [
      args.ownerId,
      args.idempotencyKey,
      args.requestHash,
      args.conversationId,
      args.runId,
      args.userMessageId,
    ],
  );
}
