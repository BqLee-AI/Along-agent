import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { notFound, stateConflict } from '../../../platform/errors.js';
import { lockCompactAuthority, type CompactBinding } from './compact-eligibility.js';
import {
  readSummarySources,
  sourceHash,
  validateStoredSources,
  type StoredSource,
} from './compact-sources.js';

export interface CompactSource {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface FrozenCompact {
  freezeId: string;
  previous: { id: string; text: string; messageIds: string[] } | null;
  messages: CompactSource[];
  coverageMessageIds: string[];
  modelId: string;
  promptRevision: string;
}

type Guard = (client: PoolClient, messageIds: readonly string[]) => Promise<void>;
const frozenContextSchema = z
  .object({
    manifest: z.object({ message_ids: z.array(z.string().uuid()).max(4096) }).strict(),
    summary: z
      .object({
        id: z.string().uuid(),
        revision: z.string(),
        text: z.string(),
        message_ids: z.array(z.string().uuid()),
      })
      .strict()
      .nullable(),
    messages: z
      .array(
        z
          .object({
            message_id: z.string().uuid(),
            role: z.enum(['user', 'assistant']),
            content: z.string(),
          })
          .strict(),
      )
      .max(4096),
    input: z.discriminatedUnion('type', [
      z
        .object({ type: z.literal('user'), message_id: z.string().uuid(), content: z.string() })
        .strict(),
      z.object({ type: z.literal('compact_control') }).strict(),
    ]),
  })
  .strict();

/** Freeze a caller-selected prefix of the Run's immutable admission manifest,
 * excluding its accepted input and its already summarized IDs. Previous coverage
 * is exact ID membership, never a timestamp bound. Model ordinals are local
 * indexes into this closure, not durable message sequences.
 */
export async function freezeCompact(
  client: PoolClient,
  binding: CompactBinding,
  args: { messageIds: readonly string[]; promptRevision: string },
  guard: Guard,
): Promise<FrozenCompact> {
  if (
    !args.messageIds.length ||
    args.messageIds.length > 4096 ||
    new Set(args.messageIds).size !== args.messageIds.length ||
    !args.promptRevision ||
    args.promptRevision.length > 128
  )
    throw stateConflict('invalid compact request');
  const modelId = await lockCompactAuthority(client, binding, guard, args.messageIds);
  const snapshot = (
    await client.query<{ context: unknown; input_message_id: string | null }>(
      `SELECT f.context,f.input_message_id FROM r3_context_freezes f
     JOIN agent_runs r ON r.id=f.run_id AND r.owner_id=f.owner_id AND r.conversation_id=f.conversation_id AND r.input_message_id IS NOT DISTINCT FROM f.input_message_id
     WHERE f.run_id=$1 AND f.owner_id=$2 AND f.conversation_id=$3`,
      [binding.runId, binding.ownerId, binding.conversationId],
    )
  ).rows[0];
  const parsed = frozenContextSchema.safeParse(snapshot?.context);
  if (!snapshot || !parsed.success) throw stateConflict('compact admission manifest unavailable');
  const frozen = parsed.data;
  const manifest = frozen.manifest.message_ids;
  const baseIds = frozen.summary?.message_ids ?? [];
  const historyIds = frozen.messages.map((message) => message.message_id);
  const coveredAtAdmission = new Set(baseIds);
  const historyAtAdmission = new Set(historyIds);
  const declared = [...baseIds, ...historyIds];
  const manifestCovered = manifest.filter((id) => coveredAtAdmission.has(id));
  const manifestHistory = manifest.filter((id) => historyAtAdmission.has(id));
  if (
    (frozen.input.type === 'user'
      ? snapshot.input_message_id !== frozen.input.message_id ||
        manifest.includes(frozen.input.message_id)
      : snapshot.input_message_id !== null) ||
    new Set(manifest).size !== manifest.length ||
    new Set(declared).size !== declared.length ||
    declared.length !== manifest.length ||
    manifestCovered.length !== baseIds.length ||
    manifestHistory.length !== historyIds.length ||
    manifestCovered.some((id, i) => id !== baseIds[i]) ||
    manifestHistory.some((id, i) => id !== historyIds[i])
  )
    throw stateConflict('compact admission manifest invalid');
  const head = (
    await client.query<{ summary_id: string; revision: string; summary_text: string }>(
      `SELECT h.summary_id,h.revision::text,s.summary_text FROM compact_heads h
      JOIN compact_summaries s ON s.id=h.summary_id AND s.owner_id=h.owner_id AND s.conversation_id=h.conversation_id
      WHERE h.owner_id=$1 AND h.conversation_id=$2`,
      [binding.ownerId, binding.conversationId],
    )
  ).rows[0];
  const previousRows = head
    ? await readSummarySources(client, binding.ownerId, binding.conversationId, head.summary_id)
    : [];
  let ancestor: string | null = head?.summary_id ?? null;
  const admittedSummary = frozen.summary?.id ?? null;
  for (let depth = 0; ancestor !== admittedSummary; depth++) {
    if (!ancestor || depth >= 4096)
      throw stateConflict('compact predecessor changed since admission');
    const step: { previous_summary_id: string | null; run_id: string } | undefined = (
      await client.query<{ previous_summary_id: string | null; run_id: string }>(
        `SELECT s.previous_summary_id,f.run_id FROM compact_summaries s
       JOIN compact_freezes f ON f.id=s.freeze_id
       WHERE s.id=$1 AND s.owner_id=$2 AND s.conversation_id=$3`,
        [ancestor, binding.ownerId, binding.conversationId],
      )
    ).rows[0];
    if (!step || step.run_id !== binding.runId)
      throw stateConflict('compact predecessor changed since admission');
    ancestor = step.previous_summary_id;
  }
  if (
    head &&
    head.summary_id === admittedSummary &&
    frozen.summary &&
    (head.revision !== frozen.summary.revision || head.summary_text !== frozen.summary.text)
  )
    throw stateConflict('compact admitted summary changed');
  const previousIds = new Set(previousRows.map((row) => row.id));
  const manifestIds = new Set(manifest);
  if (
    previousIds.size !== previousRows.length ||
    baseIds.some((id) => !previousIds.has(id)) ||
    previousRows.some((row) => !manifestIds.has(row.id)) ||
    (head?.summary_id === admittedSummary && previousRows.length !== baseIds.length)
  )
    throw stateConflict('compact predecessor coverage outside admission manifest');
  const candidates = manifest.filter((id) => !previousIds.has(id)).slice(0, args.messageIds.length);
  if (
    candidates.length !== args.messageIds.length ||
    candidates.some((id, i) => id !== args.messageIds[i])
  )
    throw stateConflict('compact sources are not a frozen uncovered prefix');
  if (previousRows.length + args.messageIds.length > 4096)
    throw stateConflict('compact coverage too large');
  const selected = await client.query<{ id: string; role: 'user' | 'assistant'; size: number }>(
    `SELECT m.id,m.role,octet_length(m.content) AS size
     FROM unnest($3::uuid[]) WITH ORDINALITY AS ids(id,n)
     JOIN messages m ON m.id=ids.id AND m.owner_id=$1 AND m.conversation_id=$2 AND m.role IN ('user','assistant')
     ORDER BY ids.n FOR SHARE OF m`,
    [binding.ownerId, binding.conversationId, args.messageIds],
  );
  if (
    selected.rows.length !== args.messageIds.length ||
    selected.rows.some((row, i) => row.id !== args.messageIds[i])
  )
    throw stateConflict('compact frozen sources unavailable');
  if (selected.rows.reduce((sum, row) => sum + row.size, 0) > 1024 * 1024)
    throw stateConflict('compact input too large');
  const messages = (
    await client.query<CompactSource>(
      `SELECT m.id,m.role,m.content AS text FROM unnest($3::uuid[]) WITH ORDINALITY AS ids(id,n)
      JOIN messages m ON m.id=ids.id AND m.owner_id=$1 AND m.conversation_id=$2 ORDER BY ids.n`,
      [binding.ownerId, binding.conversationId, args.messageIds],
    )
  ).rows;
  const historyById = new Map(frozen.messages.map((message) => [message.message_id, message]));
  if (
    messages.length !== args.messageIds.length ||
    messages.some((message) => {
      const original = historyById.get(message.id);
      return !original || original.role !== message.role || original.content !== message.text;
    })
  )
    throw stateConflict('compact frozen source changed');
  const freezeId = randomUUID();
  await client.query(
    `INSERT INTO compact_freezes(id,owner_id,conversation_id,run_id,attempt_id,pause_id,previous_summary_id,previous_revision,model_id,prompt_revision)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      freezeId,
      binding.ownerId,
      binding.conversationId,
      binding.runId,
      binding.attemptId,
      binding.pauseId,
      head?.summary_id ?? null,
      head?.revision ?? '0',
      modelId,
      args.promptRevision,
    ],
  );
  for (const [position, row] of messages.entries()) {
    await client.query(
      `INSERT INTO compact_freeze_sources(freeze_id,position,message_id,source_hash) VALUES($1,$2,$3,$4)`,
      [freezeId, position, row.id, sourceHash(row.role, row.text)],
    );
  }
  const closure = new Set([...previousIds, ...args.messageIds]);
  return {
    freezeId,
    previous: head
      ? {
          id: head.summary_id,
          text: head.summary_text,
          messageIds: manifest.filter((id) => previousIds.has(id)),
        }
      : null,
    messages,
    coverageMessageIds: manifest.filter((id) => closure.has(id)),
    modelId,
    promptRevision: args.promptRevision,
  };
}

/** Publish only a validated model result with the exact frozen closure. Rechecks
 * eligibility, CAS and original source contents under the caller's transaction. */
export async function publishCompact(
  client: PoolClient,
  binding: CompactBinding,
  args: { freezeId: string; text: string; messageIds: readonly string[] },
  guard: Guard,
): Promise<{ summaryId: string; revision: string }> {
  if (!args.text.trim() || Buffer.byteLength(args.text, 'utf8') > 65536)
    throw stateConflict('invalid compact summary');
  const modelId = await lockCompactAuthority(client, binding, guard, args.messageIds);
  const freeze = (
    await client.query<{
      previous_summary_id: string | null;
      previous_revision: string;
      model_id: string;
    }>(
      `SELECT previous_summary_id,previous_revision::text,model_id FROM compact_freezes
      WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND run_id=$4 AND attempt_id=$5 AND pause_id=$6`,
      [
        args.freezeId,
        binding.ownerId,
        binding.conversationId,
        binding.runId,
        binding.attemptId,
        binding.pauseId,
      ],
    )
  ).rows[0];
  if (!freeze || freeze.model_id !== modelId) throw stateConflict('compact freeze unavailable');
  const head = (
    await client.query<{ summary_id: string; revision: string }>(
      `SELECT summary_id,revision::text FROM compact_heads WHERE owner_id=$1 AND conversation_id=$2`,
      [binding.ownerId, binding.conversationId],
    )
  ).rows[0];
  if (
    (head?.summary_id ?? null) !== freeze.previous_summary_id ||
    (head?.revision ?? '0') !== freeze.previous_revision
  )
    throw stateConflict('compact coverage conflict');
  const previous = head
    ? await readSummarySources(client, binding.ownerId, binding.conversationId, head.summary_id)
    : [];
  const fresh = (
    await client.query<StoredSource>(
      `SELECT f.message_id AS id,f.source_hash FROM compact_freeze_sources f
      WHERE f.freeze_id=$1 ORDER BY f.position`,
      [args.freezeId],
    )
  ).rows;
  if (!fresh.length) throw stateConflict('compact freeze has no sources');
  await validateStoredSources(client, binding.ownerId, binding.conversationId, fresh);
  const sources = [...previous, ...fresh];
  const byId = new Map(sources.map((row) => [row.id, row]));
  const storedManifest = (
    await client.query<{ message_ids: unknown }>(
      `SELECT f.context->'manifest'->'message_ids' AS message_ids FROM r3_context_freezes f
     JOIN agent_runs r ON r.id=f.run_id AND r.owner_id=f.owner_id AND r.conversation_id=f.conversation_id AND r.input_message_id IS NOT DISTINCT FROM f.input_message_id
     WHERE f.run_id=$1 AND f.owner_id=$2 AND f.conversation_id=$3`,
      [binding.runId, binding.ownerId, binding.conversationId],
    )
  ).rows[0];
  const parsedManifest = z
    .array(z.string().uuid())
    .max(4096)
    .safeParse(storedManifest?.message_ids);
  if (
    !parsedManifest.success ||
    new Set(parsedManifest.data).size !== parsedManifest.data.length ||
    byId.size !== sources.length
  )
    throw stateConflict('compact admission manifest unavailable');
  const all = parsedManifest.data.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  if (
    all.length !== sources.length ||
    all.length !== args.messageIds.length ||
    all.some((row, i) => row.id !== args.messageIds[i])
  )
    throw stateConflict('compact coverage mismatch');
  const summaryId = randomUUID();
  const revision = (BigInt(freeze.previous_revision) + 1n).toString();
  await client.query(
    `INSERT INTO compact_summaries(id,freeze_id,owner_id,conversation_id,previous_summary_id,revision,summary_text)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      summaryId,
      args.freezeId,
      binding.ownerId,
      binding.conversationId,
      freeze.previous_summary_id,
      revision,
      args.text,
    ],
  );
  for (const [position, row] of all.entries())
    await client.query(
      `INSERT INTO compact_summary_sources(summary_id,position,message_id,source_hash) VALUES($1,$2,$3,$4)`,
      [summaryId, position, row.id, row.source_hash],
    );
  await client.query(
    `INSERT INTO compact_heads(conversation_id,owner_id,summary_id,revision) VALUES($1,$2,$3,$4)
    ON CONFLICT(conversation_id) DO UPDATE SET summary_id=EXCLUDED.summary_id,revision=EXCLUDED.revision`,
    [binding.conversationId, binding.ownerId, summaryId, revision],
  );
  return { summaryId, revision };
}

/** Admission must call in its transaction before inserting or freezing visible
 * messages. The returned IDs are exact set membership, not a time cutoff. */
export async function readCompactView(
  client: PoolClient,
  ownerId: string,
  conversationId: string,
): Promise<{
  summary: { id: string; revision: string; text: string; messageIds: string[] } | null;
  uncoveredIds: string[];
}> {
  const conversation = await client.query(
    `SELECT 1 FROM conversations WHERE id=$1 AND owner_id=$2 AND status='open' FOR UPDATE`,
    [conversationId, ownerId],
  );
  if (!conversation.rowCount) throw notFound('compact conversation unavailable');
  const head = (
    await client.query<{ id: string; revision: string; text: string }>(
      `SELECT s.id,h.revision::text,s.summary_text AS text FROM compact_heads h
     JOIN compact_summaries s ON s.id=h.summary_id AND s.owner_id=h.owner_id AND s.conversation_id=h.conversation_id
     WHERE h.owner_id=$1 AND h.conversation_id=$2`,
      [ownerId, conversationId],
    )
  ).rows[0];
  const sources = head ? await readSummarySources(client, ownerId, conversationId, head.id) : [];
  const messages = await client.query<{ id: string }>(
    `SELECT m.id FROM messages m WHERE m.owner_id=$1 AND m.conversation_id=$2 AND m.role IN ('user','assistant')
     AND NOT EXISTS (SELECT 1 FROM compact_summary_sources s WHERE s.summary_id=$3 AND s.message_id=m.id)
     ORDER BY m.created_at,m.id LIMIT 4097`,
    [ownerId, conversationId, head?.id ?? null],
  );
  if (messages.rows.length > 4096)
    throw stateConflict('compact view exceeds bounded representation');
  return {
    summary: head ? { ...head, messageIds: sources.map((source) => source.id) } : null,
    uncoveredIds: messages.rows.map((row) => row.id),
  };
}
