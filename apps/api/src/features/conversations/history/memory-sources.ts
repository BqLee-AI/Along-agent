import type { PoolClient } from 'pg';
import { notFound } from '../../../platform/errors.js';
import type { MemorySources } from '../../memory/public.js';
import { validateCompactSources } from '../compact/compact-sources.js';

/** The conversations module owns message visibility and source qualification. */
export const conversationMemorySources: MemorySources = {
  async validate(client, { ownerId, conversationId, messageIds, purpose, summaryId }) {
    const conversation = await client.query(
      'SELECT id FROM conversations WHERE id=$1 AND owner_id=$2 FOR SHARE',
      [conversationId, ownerId],
    );
    if (!conversation.rowCount) throw notFound('memory source not found');
    if (purpose === 'compact' || summaryId) {
      if (!summaryId) throw notFound('memory source not found');
      await validateCompactSources(client, { ownerId, conversationId, summaryId, messageIds });
      return;
    }
    const roles = purpose === 'read' ? ['user', 'assistant'] : ['user'];
    const messages = await client.query<{ id: string }>(
      `SELECT id FROM messages WHERE owner_id=$1 AND conversation_id=$2
       AND id=ANY($3::uuid[]) AND role=ANY($4::text[]) FOR SHARE`,
      [ownerId, conversationId, messageIds, roles],
    );
    if (messages.rows.length !== new Set(messageIds).size || !messageIds.length)
      throw notFound('memory source not found');
  },
};

/** Resolve an owner-visible original source within the caller's transaction.
 * Share locks keep both ownership and message content stable until commit. */
export async function readMemorySource(
  client: PoolClient,
  binding: { ownerId: string; conversationId: string; messageId: string },
): Promise<{ role: 'user' | 'assistant'; content: string }> {
  const { ownerId, conversationId, messageId } = binding;
  const conversation = await client.query(
    'SELECT id FROM conversations WHERE id=$1 AND owner_id=$2 FOR SHARE',
    [conversationId, ownerId],
  );
  if (!conversation.rowCount) throw notFound('memory source not found');
  const result = await client.query<{ role: 'user' | 'assistant'; content: string }>(
    `SELECT role,content FROM messages WHERE id=$1 AND owner_id=$2 AND conversation_id=$3
       AND role IN ('user','assistant') FOR SHARE`,
    [messageId, ownerId, conversationId],
  );
  if (!result.rows[0]) throw notFound('memory source not found');
  return result.rows[0];
}

/** Select and lock the Run's owner-visible accepted user message, never a model-supplied ID. */
export async function readMemoryRunSource(
  client: PoolClient,
  binding: { ownerId: string; conversationId: string; runId: string },
): Promise<string> {
  const { rows } = await client.query<{ input_message_id: string }>(
    `SELECT r.input_message_id FROM agent_runs r
     JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
     JOIN messages m ON m.id=r.input_message_id AND m.owner_id=r.owner_id
       AND m.conversation_id=r.conversation_id AND m.role='user'
     WHERE r.id=$1 AND r.owner_id=$2 AND r.conversation_id=$3
     FOR SHARE OF r,c,m`,
    [binding.runId, binding.ownerId, binding.conversationId],
  );
  if (!rows[0]) throw notFound('Run source not found');
  return rows[0].input_message_id;
}
