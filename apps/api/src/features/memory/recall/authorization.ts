import type { PoolClient } from 'pg';
import { isUuid, stateConflict, validationError } from '../../../platform/errors.js';
import type { MemorySources } from '../types.js';

/** Lock in stable order; caller keeps locks through disclosure/acceptance commit. */
export async function validateMemoryRevisions(
  client: PoolClient,
  sources: MemorySources,
  ownerId: string,
  items: { id: string; revision: number }[],
): Promise<void> {
  if (!isUuid(ownerId)) throw validationError('invalid owner');
  const ordered = [...items].sort((a, b) => a.id.localeCompare(b.id));
  for (const item of ordered) {
    if (!isUuid(item.id) || !Number.isSafeInteger(item.revision) || item.revision < 1)
      throw validationError('invalid memory revision');
    const { rows } = await client.query<{
      revision: number;
      conversation_id: string;
      message_ids: string[];
      summary_id: string | null;
    }>(
      `SELECT r.revision,r.conversation_id,r.message_ids,r.summary_id FROM r3_memories m
       JOIN r3_memory_revisions r ON r.owner_id=m.owner_id AND r.memory_id=m.id AND r.revision=m.current_revision
       WHERE m.owner_id=$1 AND m.id=$2 AND m.status='active' AND (r.expires_at IS NULL OR r.expires_at > clock_timestamp())
       FOR UPDATE OF m`,
      [ownerId, item.id],
    );
    const row = rows[0];
    if (!row || row.revision !== item.revision) throw stateConflict('memory candidate changed');
    await sources.validate(client, {
      ownerId,
      conversationId: row.conversation_id,
      messageIds: row.message_ids,
      purpose: 'read',
      ...(row.summary_id ? { summaryId: row.summary_id } : {}),
    });
  }
}
