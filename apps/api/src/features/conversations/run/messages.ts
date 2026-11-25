import type { Pool, PoolClient } from 'pg';
import type { HarnessStart } from '@along/contracts';
import { stateConflict } from '../../../platform/errors.js';
import type { RunContext } from '../contracts.js';

export interface ConversationRow {
  id: string;
  owner_id: string;
  status: string;
  confirmed_timezone_id: string | null;
  anchor_received_at_utc: Date | null;
}

export async function getConversation(
  client: Pick<Pool | PoolClient, 'query'>,
  conversationId: string,
): Promise<ConversationRow | null> {
  const { rows } = await client.query<ConversationRow>(
    `SELECT id, owner_id, status, confirmed_timezone_id, anchor_received_at_utc
     FROM conversations WHERE id = $1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

export async function createConversation(
  client: Pick<Pool | PoolClient, 'query'>,
  args: { ownerId: string; anchorIso: string; title: string },
): Promise<ConversationRow> {
  const { rows } = await client.query<ConversationRow>(
    `INSERT INTO conversations (id, owner_id, title, anchor_received_at_utc)
     VALUES (gen_random_uuid(), $1, $2, $3)
     RETURNING id, owner_id, status, confirmed_timezone_id, anchor_received_at_utc`,
    [args.ownerId, args.title, args.anchorIso],
  );
  const row = rows[0];
  if (!row) throw new Error('conversation insert returned no row');
  return row;
}

// First confirmed timezone wins and freezes for the conversation; later
// messages cannot move the anchor's clock.
export async function freezeConversationTimezone(
  client: Pick<Pool | PoolClient, 'query'>,
  conversationId: string,
  timezoneId: string,
): Promise<void> {
  await client.query(
    `UPDATE conversations SET confirmed_timezone_id = $2, updated_at = now()
     WHERE id = $1 AND confirmed_timezone_id IS NULL`,
    [conversationId, timezoneId],
  );
}

export async function insertMessage(
  client: Pick<Pool | PoolClient, 'query'>,
  args: {
    ownerId: string;
    conversationId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    requestId: string | null;
    sourceRunId?: string | null;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO messages (id, owner_id, conversation_id, role, content, request_id, created_at, source_run_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, clock_timestamp(), $6) RETURNING id`,
    [
      args.ownerId,
      args.conversationId,
      args.role,
      args.content,
      args.requestId,
      args.sourceRunId ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('message insert returned no row');
  return id;
}

// Freeze the newest 63 prompt-eligible predecessors plus the complete accepted
// input. PostgreSQL preserves microsecond ordering; current input is always last.
export async function listHarnessMessageRefs(
  client: Pick<Pool | PoolClient, 'query'>,
  binding: Pick<RunContext, 'ownerId' | 'conversationId' | 'userMessageId'>,
): Promise<string[]> {
  const { ownerId, conversationId, userMessageId } = binding;
  const { rows } = await client.query<{ id: string }>(
    `WITH accepted AS (
       SELECT m.id,m.created_at FROM messages m
       WHERE m.id=$3 AND m.owner_id=$1 AND m.conversation_id=$2 AND m.role='user'
         AND EXISTS (SELECT 1 FROM conversations c WHERE c.id=$2 AND c.owner_id=$1)
     ), history AS (
       SELECT m.id,m.created_at FROM messages m CROSS JOIN accepted a
       WHERE m.owner_id=$1 AND m.conversation_id=$2 AND m.role IN ('user','assistant')
         AND m.source_run_id IS NULL AND m.id<>a.id
       ORDER BY m.created_at DESC,m.id DESC LIMIT 63
     )
     SELECT id FROM (
       SELECT *,false AS current_input FROM history
       UNION ALL SELECT *,true AS current_input FROM accepted
     ) visible ORDER BY current_input,created_at,id`,
    [ownerId, conversationId, userMessageId],
  );
  if (rows.at(-1)?.id !== userMessageId) throw stateConflict('Run accepted message missing');
  return rows.map((row) => row.id);
}

// Execution and resume resolve only frozen, ordered references, never reselect
// later history. Every message is owner/conversation/eligible-role scoped.
export async function readHarnessMessages(
  client: Pick<Pool | PoolClient, 'query'>,
  binding: Pick<RunContext, 'ownerId' | 'conversationId' | 'userMessageId'>,
  messageRefs: readonly string[],
): Promise<HarnessStart['messages']> {
  const { ownerId, conversationId, userMessageId } = binding;
  if (
    messageRefs.length === 0 ||
    messageRefs.length > 64 ||
    messageRefs.at(-1) !== userMessageId ||
    new Set(messageRefs).size !== messageRefs.length
  )
    throw stateConflict('snapshot message reference conflict');
  const { rows } = await client.query<HarnessStart['messages'][number]>(
    `SELECT m.id AS message_id,m.role,m.content
     FROM unnest($3::uuid[]) WITH ORDINALITY AS refs(id,position)
     JOIN messages m ON m.id=refs.id AND m.owner_id=$1 AND m.conversation_id=$2
       AND m.role IN ('user','assistant') AND m.source_run_id IS NULL
     WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.id=$2 AND c.owner_id=$1)
     ORDER BY refs.position`,
    [ownerId, conversationId, messageRefs],
  );
  if (rows.length !== messageRefs.length || rows.at(-1)?.role !== 'user')
    throw stateConflict('snapshot message reference conflict');
  return rows;
}
