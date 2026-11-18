import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { notFound, stateConflict } from '../../../platform/errors.js';

export interface StoredSource {
  id: string;
  source_hash: Buffer;
}

export function sourceHash(role: string, text: string): Buffer {
  return createHash('sha256')
    .update(JSON.stringify([role, text]), 'utf8')
    .digest();
}

export async function readSummarySources(
  client: PoolClient,
  ownerId: string,
  conversationId: string,
  summaryId: string,
): Promise<StoredSource[]> {
  const rows = (
    await client.query<StoredSource>(
      `SELECT s.message_id AS id,s.source_hash FROM compact_summary_sources s
      JOIN compact_summaries c ON c.id=s.summary_id AND c.owner_id=$1 AND c.conversation_id=$2
      WHERE s.summary_id=$3 ORDER BY s.position`,
      [ownerId, conversationId, summaryId],
    )
  ).rows;
  if (!rows.length) throw stateConflict('compact source closure unavailable');
  await validateStoredSources(client, ownerId, conversationId, rows);
  return rows;
}

export async function validateStoredSources(
  client: PoolClient,
  ownerId: string,
  conversationId: string,
  rows: StoredSource[],
): Promise<void> {
  for (const row of rows) {
    const message = (
      await client.query<{ role: string; content: string }>(
        `SELECT role,content FROM messages WHERE id=$1 AND owner_id=$2 AND conversation_id=$3
       AND role IN ('user','assistant') AND octet_length(content) <= 1048576 FOR SHARE`,
        [row.id, ownerId, conversationId],
      )
    ).rows[0];
    if (!message || !sourceHash(message.role, message.content).equals(row.source_hash))
      throw stateConflict('compact source changed');
  }
}

/** Validate a nonempty subset against a published summary's exact owner-scoped original source closure. */
export async function validateCompactSources(
  client: PoolClient,
  args: {
    ownerId: string;
    conversationId: string;
    summaryId: string;
    messageIds: readonly string[];
  },
): Promise<void> {
  if (!args.messageIds.length || new Set(args.messageIds).size !== args.messageIds.length)
    throw notFound('compact sources unavailable');
  const rows = await readSummarySources(client, args.ownerId, args.conversationId, args.summaryId);
  const available = new Set(rows.map((row) => row.id));
  if (args.messageIds.some((id) => !available.has(id)))
    throw notFound('compact sources unavailable');
}
