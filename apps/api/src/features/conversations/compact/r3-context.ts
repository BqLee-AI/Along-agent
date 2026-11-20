import { HARNESS_MAX_FRAME_BYTES } from '@along/contracts';
import type { PoolClient } from 'pg';
import { ApplicationError, notFound, stateConflict } from '../../../platform/errors.js';
import { readCompactView } from './compact-store.js';

const MAX_MANIFEST_MESSAGES = 4096;
// readCompactView validates covered originals as well as returning the summary.
// Bound that validation before allowing it to read any original content.
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

type Message = { message_id: string; role: 'user' | 'assistant'; content: string };
export interface R3Context {
  manifest: { message_ids: string[] };
  summary: { id: string; revision: string; text: string; message_ids: string[] } | null;
  messages: Message[];
  input: { type: 'user'; message_id: string; content: string };
}
export interface R3ControlContext extends Omit<R3Context, 'input'> {
  input: { type: 'compact_control' };
}
export interface R3ControlBinding {
  ownerId: string;
  conversationId: string;
  runId: string;
}
export interface R3ContextBinding {
  ownerId: string;
  conversationId: string;
  runId: string;
  userMessageId: string;
}

function capacity(): never {
  throw new ApplicationError(
    422,
    'HARNESS_CONTEXT_LIMIT',
    'conversation context exceeds safe capacity',
  );
}

/** Caller owns the transaction. Lock the owner-scoped conversation BEFORE inserting
 * the accepted message and retain the lock through this call and commit. All other
 * visible-message writers and compact publication must take the same lock. Insert
 * the Run before this call; no model or tool I/O belongs in this transaction. */
export async function freezeR3Context(
  client: PoolClient,
  binding: R3ContextBinding,
): Promise<R3Context> {
  return freezeContext(client, binding, binding.userMessageId) as Promise<R3Context>;
}

/** The control Run must already have a null input_message_id; the caller holds
 * the conversation lock through admission and commit. */
export async function freezeR3ControlContext(
  client: PoolClient,
  binding: R3ControlBinding,
): Promise<R3ControlContext> {
  return freezeContext(client, binding, null) as Promise<R3ControlContext>;
}

async function freezeContext(
  client: PoolClient,
  binding: R3ControlBinding,
  userMessageId: string | null,
): Promise<R3Context | R3ControlContext> {
  const { ownerId, conversationId, runId } = binding;
  const locked = await client.query(
    `SELECT 1 FROM conversations WHERE id=$1 AND owner_id=$2 AND status='open' FOR UPDATE`,
    [conversationId, ownerId],
  );
  if (!locked.rowCount) throw notFound('conversation unavailable');
  const run = await client.query(
    `SELECT 1 FROM agent_runs WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND input_message_id IS NOT DISTINCT FROM $4::uuid`,
    [runId, ownerId, conversationId, userMessageId],
  );
  if (!run.rowCount) throw stateConflict('R3 Run binding unavailable');

  // Counts and byte sums are evaluated in PostgreSQL before readCompactView can
  // materialize its source closure or any original message content in Node.
  const sizes = (
    await client.query<{
      count: string;
      bytes: string;
      max_bytes: number;
      uncovered: string;
      uncovered_bytes: string;
      sources: string;
    }>(
      `SELECT count(*)::text AS count, coalesce(sum(octet_length(m.content)),0)::text AS bytes,
       coalesce(max(octet_length(m.content)),0) AS max_bytes,
       count(*) FILTER (WHERE s.message_id IS NULL)::text AS uncovered,
       coalesce(sum(octet_length(m.content)) FILTER (WHERE s.message_id IS NULL),0)::text AS uncovered_bytes,
       (SELECT count(*)::text FROM compact_heads h JOIN compact_summary_sources cs ON cs.summary_id=h.summary_id
         WHERE h.owner_id=$1 AND h.conversation_id=$2) AS sources
     FROM messages m
     LEFT JOIN compact_heads h ON h.owner_id=$1 AND h.conversation_id=$2
     LEFT JOIN compact_summary_sources s ON s.summary_id=h.summary_id AND s.message_id=m.id
     WHERE m.owner_id=$1 AND m.conversation_id=$2 AND m.role IN ('user','assistant')
       AND m.source_run_id IS NULL`,
      [ownerId, conversationId],
    )
  ).rows[0];
  if (
    !sizes ||
    Number(sizes.count) > MAX_MANIFEST_MESSAGES + 1 ||
    Number(sizes.sources) > MAX_MANIFEST_MESSAGES ||
    Number(sizes.uncovered) > MAX_MANIFEST_MESSAGES ||
    Number(sizes.bytes) > MAX_SOURCE_BYTES ||
    sizes.max_bytes > HARNESS_MAX_FRAME_BYTES ||
    Number(sizes.uncovered_bytes) > HARNESS_MAX_FRAME_BYTES
  )
    capacity();

  const view = await readCompactView(client, ownerId, conversationId);
  if (
    userMessageId &&
    (view.summary?.messageIds.includes(userMessageId) || !view.uncoveredIds.includes(userMessageId))
  )
    throw stateConflict('R3 accepted message is not uncovered');
  const historyIds = view.uncoveredIds.filter((id) => id !== userMessageId);
  const sourceIds = view.summary?.messageIds ?? [];
  const selectedIds = [...sourceIds, ...historyIds];
  if (selectedIds.length > MAX_MANIFEST_MESSAGES) capacity();
  if (new Set(selectedIds).size !== selectedIds.length) throw stateConflict('R3 coverage conflict');
  // The membership comes only from the validated compact view, not a time
  // cutoff. A late committed message may sort between covered predecessors.
  const ordered = await client.query<{ id: string }>(
    `SELECT id FROM messages WHERE owner_id=$1 AND conversation_id=$2
       AND role IN ('user','assistant') AND source_run_id IS NULL
       AND id=ANY($3::uuid[]) ORDER BY created_at,id`,
    [ownerId, conversationId, selectedIds],
  );
  if (ordered.rows.length !== selectedIds.length)
    throw stateConflict('R3 manifest source unavailable');
  const manifestIds = ordered.rows.map((row) => row.id);
  const covered = new Set(sourceIds);
  const summaryIds = manifestIds.filter((id) => covered.has(id));

  const ids = userMessageId ? [...historyIds, userMessageId] : historyIds;
  const messages = (
    await client.query<Message>(
      `SELECT m.id AS message_id,m.role,m.content FROM unnest($3::uuid[]) WITH ORDINALITY AS refs(id,position)
     JOIN messages m ON m.id=refs.id AND m.owner_id=$1 AND m.conversation_id=$2 AND m.role IN ('user','assistant')
       AND m.source_run_id IS NULL
     ORDER BY refs.position`,
      [ownerId, conversationId, ids],
    )
  ).rows;
  const input = userMessageId ? messages.pop() : undefined;
  if (
    messages.length !== historyIds.length ||
    (userMessageId && (!input || input.message_id !== userMessageId || input.role !== 'user'))
  )
    throw stateConflict('R3 message binding unavailable');
  const shared = {
    manifest: { message_ids: manifestIds },
    summary: view.summary
      ? {
          id: view.summary.id,
          revision: view.summary.revision,
          text: view.summary.text,
          message_ids: summaryIds,
        }
      : null,
    messages,
  };
  const context: R3Context | R3ControlContext = input
    ? { ...shared, input: { type: 'user', message_id: input.message_id, content: input.content } }
    : { ...shared, input: { type: 'compact_control' } };
  const json = JSON.stringify(context);
  if (Buffer.byteLength(json, 'utf8') > HARNESS_MAX_FRAME_BYTES) capacity();
  const storedSize = (
    await client.query<{ bytes: number }>('SELECT octet_length($1::jsonb::text) AS bytes', [json])
  ).rows[0];
  if (!storedSize || storedSize.bytes > HARNESS_MAX_FRAME_BYTES) capacity();
  await client.query(
    `INSERT INTO r3_context_freezes(run_id,owner_id,conversation_id,input_message_id,context)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [runId, ownerId, conversationId, userMessageId, json],
  );
  return context;
}

/** Resolve only the immutable admission snapshot; never select the current head. */
export async function readR3Context(
  client: PoolClient,
  binding: R3ContextBinding,
): Promise<R3Context> {
  const result = await client.query<{ context: R3Context }>(
    `SELECT f.context FROM r3_context_freezes f
     JOIN agent_runs r ON r.id=f.run_id AND r.owner_id=f.owner_id AND r.conversation_id=f.conversation_id AND r.input_message_id=f.input_message_id
     JOIN conversations c ON c.id=f.conversation_id AND c.owner_id=f.owner_id
     WHERE f.owner_id=$1 AND f.conversation_id=$2 AND f.run_id=$3 AND f.input_message_id=$4`,
    [binding.ownerId, binding.conversationId, binding.runId, binding.userMessageId],
  );
  if (!result.rows[0]) throw notFound('R3 context unavailable');
  return result.rows[0].context;
}

/** Resolve an idle control Run's exact immutable admission snapshot. */
export async function readR3ControlContext(
  client: PoolClient,
  binding: R3ControlBinding,
): Promise<R3ControlContext> {
  const result = await client.query<{ context: R3ControlContext }>(
    `SELECT f.context FROM r3_context_freezes f
     JOIN agent_runs r ON r.id=f.run_id AND r.owner_id=f.owner_id AND r.conversation_id=f.conversation_id AND r.input_message_id IS NULL
     JOIN conversations c ON c.id=f.conversation_id AND c.owner_id=f.owner_id
     WHERE f.owner_id=$1 AND f.conversation_id=$2 AND f.run_id=$3 AND f.input_message_id IS NULL
       AND f.context->'input'->>'type'='compact_control'`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  if (!result.rows[0]) throw notFound('R3 context unavailable');
  return result.rows[0].context;
}
