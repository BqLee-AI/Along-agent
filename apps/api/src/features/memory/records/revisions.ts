import type { PoolClient } from 'pg';
import type { MemoryRecord } from '../types.js';

export type MemoryRevisionRow = {
  id: string;
  owner_id: string;
  conversation_id: string;
  message_ids: string[];
  content: string;
  source_kind: MemoryRecord['sourceKind'];
  summary_id: string | null;
  revision: number;
  status: MemoryRecord['status'];
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export const memoryRevisionProjection = `m.id, m.owner_id, r.conversation_id, r.message_ids, r.content,
  r.source_kind, r.summary_id, r.revision, m.status, r.expires_at, m.created_at, m.updated_at`;
export const currentRevisionJoin = `FROM r3_memories m JOIN r3_memory_revisions r
  ON r.owner_id=m.owner_id AND r.memory_id=m.id AND r.revision=m.current_revision`;

export function memoryRecord(row: MemoryRevisionRow): MemoryRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    messageIds: row.message_ids,
    content: row.content,
    sourceKind: row.source_kind,
    summaryId: row.summary_id,
    revision: row.revision,
    status: row.status,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Mutation responses read their stored revision even when its new expiry is already past. */
export async function loadMemoryRevision(
  client: PoolClient,
  ownerId: string,
  memoryId: string,
  mode: 'active-locked' | 'stored' = 'active-locked',
): Promise<MemoryRevisionRow | null> {
  const { rows } = await client.query<MemoryRevisionRow>(
    `SELECT ${memoryRevisionProjection} ${currentRevisionJoin}
    WHERE m.owner_id=$1 AND m.id=$2 ${
      mode === 'active-locked'
        ? "AND m.status='active' AND (r.expires_at IS NULL OR r.expires_at > clock_timestamp()) FOR UPDATE OF m"
        : ''
    }`,
    [ownerId, memoryId],
  );
  return rows[0] ?? null;
}

export async function insertMemoryRevision(
  client: PoolClient,
  ownerId: string,
  memoryId: string,
  revision: number,
  input: Pick<MemoryRecord, 'conversationId' | 'messageIds' | 'content'>,
  sourceKind: MemoryRecord['sourceKind'],
  summaryId: string | null,
  expiresAt: string | Date | null,
): Promise<void> {
  await client.query(
    `INSERT INTO r3_memory_revisions(owner_id,memory_id,revision,conversation_id,message_ids,content,source_kind,summary_id,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      ownerId,
      memoryId,
      revision,
      input.conversationId,
      input.messageIds,
      input.content,
      sourceKind,
      summaryId,
      expiresAt,
    ],
  );
}
