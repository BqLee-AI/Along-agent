import type { PoolClient } from 'pg';
import { z } from 'zod';
import { notFound, stateConflict, validationError } from '../../http/errors.js';

export type IdleCompactReceipt =
  | { status: 'no_content'; runId: null }
  | { status: 'accepted'; runId: string };

/** The caller owns the transaction and must check active owner authorization.
 * This lock must be acquired before conversation and admission locks and held
 * until the receipt and, for accepted requests, the complete Run are committed. */
export async function lockIdleCompactRequest(
  client: PoolClient,
  ownerId: string,
  conversationId: string,
  key: string,
): Promise<IdleCompactReceipt | null> {
  if (!z.string().uuid().safeParse(key).success)
    throw validationError('invalid compact idempotency key');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    JSON.stringify([ownerId.toLowerCase(), key.toLowerCase()]),
  ]);
  const prior = (
    await client.query<{ conversation_id: string; run_id: string | null }>(
      'SELECT conversation_id,run_id FROM idle_compact_requests WHERE owner_id=$1 AND idempotency_key=$2',
      [ownerId, key],
    )
  ).rows[0];
  if (!prior) return null;
  if (prior.conversation_id !== conversationId.toLowerCase())
    throw stateConflict('compact idempotency key reused');
  return prior.run_id
    ? { status: 'accepted', runId: prior.run_id }
    : { status: 'no_content', runId: null };
}

/** Must follow lockIdleCompactRequest in the same transaction. A null runId is
 * reserved for a genuinely empty uncovered view, determined under the locked
 * conversation. No external work may happen inside the admission transaction. */
export async function saveIdleCompactRequest(
  client: PoolClient,
  ownerId: string,
  conversationId: string,
  key: string,
  runId: string | null,
): Promise<IdleCompactReceipt> {
  const inserted = await client.query(
    `INSERT INTO idle_compact_requests(owner_id,idempotency_key,conversation_id,run_id)
     SELECT c.owner_id,$3,c.id,$4::uuid FROM conversations c
     WHERE c.owner_id=$1 AND c.id=$2 AND c.status='open'
       AND (($4::uuid IS NULL AND NOT EXISTS (
         SELECT 1 FROM messages m
         LEFT JOIN compact_heads h ON h.owner_id=c.owner_id AND h.conversation_id=c.id
         WHERE m.owner_id=c.owner_id AND m.conversation_id=c.id AND m.role IN ('user','assistant')
           AND NOT EXISTS (SELECT 1 FROM compact_summary_sources s WHERE s.summary_id=h.summary_id AND s.message_id=m.id)
       )) OR ($4::uuid IS NOT NULL AND EXISTS (
         SELECT 1 FROM agent_runs r JOIN r3_context_freezes f ON f.run_id=r.id
         WHERE r.id=$4 AND r.owner_id=$1 AND r.conversation_id=c.id
           AND r.input_message_id IS NULL AND f.owner_id=$1 AND f.conversation_id=c.id
           AND f.input_message_id IS NULL AND f.context->'input' = '{"type":"compact_control"}'::jsonb
           AND jsonb_array_length(f.context->'messages') > 0
       )))`,
    [ownerId, conversationId, key, runId],
  );
  if (!inserted.rowCount) throw notFound('control Run or conversation unavailable');
  return runId ? { status: 'accepted', runId } : { status: 'no_content', runId: null };
}
