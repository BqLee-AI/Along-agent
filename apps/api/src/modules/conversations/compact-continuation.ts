import {
  HarnessR3ContextSchema,
  HarnessR3SnapshotSchema,
  type HarnessR3Context,
  type HarnessR3Snapshot,
} from '@along/contracts';
import type { PoolClient } from 'pg';
import { HttpError, stateConflict } from '../../http/errors.js';
import { assertCompactEligibility } from './compact-operations.js';
import { validateCompactSources } from './compact-sources.js';
import type { CompactBinding } from './compact-store.js';
import { readR3Context, readR3ControlContext } from './r3-context.js';
import { routingIdentity } from './routing-checkpoints.js';

/** Validate a v4 snapshot against the original admission and immutable source
 * facts; schema validation alone cannot authorize a claimed context. */
export async function validateR3SnapshotContext(
  client: PoolClient,
  binding: { ownerId: string; conversationId: string; runId: string; userMessageId: string | null },
  snapshot: HarnessR3Snapshot,
): Promise<void> {
  const admission =
    binding.userMessageId === null
      ? await readR3ControlContext(client, binding)
      : await readR3Context(client, { ...binding, userMessageId: binding.userMessageId });
  const initial = admission.summary
    ? { id: admission.summary.id, revision: admission.summary.revision }
    : null;
  if (
    routingIdentity(snapshot.original_manifest) !== routingIdentity(admission.manifest) ||
    routingIdentity(snapshot.original_summary) !== routingIdentity(initial) ||
    routingIdentity(snapshot.context.input) !== routingIdentity(admission.input)
  )
    throw stateConflict('snapshot admission binding conflict');
  const messages = snapshot.context.messages;
  const rows = (
    await client.query<{ id: string; role: string; content: string }>(
      `SELECT m.id,m.role,m.content FROM unnest($3::uuid[]) WITH ORDINALITY ids(id,n)
     JOIN messages m ON m.id=ids.id AND m.owner_id=$1 AND m.conversation_id=$2
     WHERE m.role IN ('user','assistant') ORDER BY ids.n FOR SHARE OF m`,
      [binding.ownerId, binding.conversationId, messages.map((message) => message.message_id)],
    )
  ).rows;
  if (
    rows.length !== messages.length ||
    rows.some(
      (row, i) =>
        row.id !== messages[i]!.message_id ||
        row.role !== messages[i]!.role ||
        row.content !== messages[i]!.content,
    )
  )
    throw stateConflict('snapshot original message conflict');
  const summary = snapshot.context.summary;
  if (summary) {
    const stored = (
      await client.query<{ text: string; revision: string; run_id: string }>(
        `SELECT s.summary_text AS text,s.revision::text,f.run_id FROM compact_summaries s
       JOIN compact_freezes f ON f.id=s.freeze_id WHERE s.id=$1 AND s.owner_id=$2 AND s.conversation_id=$3`,
        [summary.id, binding.ownerId, binding.conversationId],
      )
    ).rows[0];
    if (
      !stored ||
      stored.text !== summary.text ||
      stored.revision !== summary.revision ||
      (summary.id !== admission.summary?.id && stored.run_id !== binding.runId)
    )
      throw stateConflict('snapshot summary binding conflict');
    if (summary.id !== admission.summary?.id) {
      const chain = (
        await client.query<{
          id: string;
          previous_summary_id: string | null;
          run_id: string;
          published: boolean;
        }>(
          `WITH RECURSIVE chain AS (
           SELECT s.id,s.previous_summary_id,f.run_id,ARRAY[s.id] AS visited,1 AS depth
           FROM compact_summaries s JOIN compact_freezes f ON f.id=s.freeze_id
           WHERE s.id=$1 AND s.owner_id=$2 AND s.conversation_id=$3
           UNION ALL
           SELECT s.id,s.previous_summary_id,f.run_id,c.visited||s.id,c.depth+1
           FROM chain c JOIN compact_summaries s ON s.id=c.previous_summary_id
           JOIN compact_freezes f ON f.id=s.freeze_id
           WHERE s.owner_id=$2 AND s.conversation_id=$3 AND s.id IS DISTINCT FROM $4::uuid
             AND NOT s.id=ANY(c.visited) AND c.depth<4096
         ) SELECT c.id,c.previous_summary_id,c.run_id,
           EXISTS(SELECT 1 FROM compact_operations o WHERE o.summary_id=c.id AND o.status='published'
             AND o.owner_id=$2 AND o.conversation_id=$3 AND o.run_id=$5) AS published
           FROM chain c ORDER BY c.depth`,
          [
            summary.id,
            binding.ownerId,
            binding.conversationId,
            admission.summary?.id ?? null,
            binding.runId,
          ],
        )
      ).rows;
      if (
        !chain.length ||
        chain.some((link) => link.run_id !== binding.runId || !link.published) ||
        chain[chain.length - 1]!.previous_summary_id !== (admission.summary?.id ?? null)
      )
        throw stateConflict('snapshot summary chain conflict');
    }
    const ids = (
      await client.query<{ message_id: string }>(
        'SELECT message_id FROM compact_summary_sources WHERE summary_id=$1 ORDER BY position',
        [summary.id],
      )
    ).rows.map((row) => row.message_id);
    if (
      ids.length !== summary.message_ids.length ||
      ids.some((id, i) => id !== summary.message_ids[i])
    )
      throw stateConflict('snapshot summary coverage conflict');
    await validateCompactSources(client, {
      ownerId: binding.ownerId,
      conversationId: binding.conversationId,
      summaryId: summary.id,
      messageIds: ids,
    });
  } else if (admission.summary) {
    throw stateConflict('snapshot omits original summary');
  }
}

/** Verify the immutable continuation receipt again when the successor opens;
 * it must differ from the pause only by the ledger's exact cumulative usage. */
export async function readConsumedCompactContinuation(
  client: PoolClient,
  binding: {
    ownerId: string;
    conversationId: string;
    runId: string;
    attemptId: string;
    userMessageId: string | null;
  },
): Promise<{ snapshot: HarnessR3Snapshot; context: HarnessR3Context }> {
  const row = (
    await client.query<{
      pause_snapshot: unknown;
      snapshot: unknown;
      context: unknown;
      status: string;
      purpose: string;
      call_started: boolean;
      usage_recorded: boolean;
      usage_tokens: string | null;
      summary_id: string | null;
    }>(
      `SELECT p.snapshot AS pause_snapshot,p.purpose,c.snapshot,c.context,o.status,o.call_started,o.usage_recorded,
             o.usage_tokens::text,o.summary_id
      FROM harness_pause_resumes r JOIN harness_pauses p ON p.id=r.pause_id
      JOIN compact_operations o ON o.pause_id=p.id
      JOIN compact_continuations c ON c.pause_id=p.id AND c.attempt_id=r.attempt_id
      WHERE r.attempt_id=$1 AND r.owner_id=$2 AND r.run_id=$3 AND r.source='runtime'
        AND p.owner_id=$2 AND p.conversation_id=$4 AND p.state='consumed'`,
      [binding.attemptId, binding.ownerId, binding.runId, binding.conversationId],
    )
  ).rows[0];
  if (
    !row ||
    !['published', 'failed'].includes(row.status) ||
    (row.purpose === 'automatic_compact' && row.status === 'failed') ||
    (binding.userMessageId === null && row.status !== 'published') ||
    (row.call_started && !row.usage_recorded)
  )
    throw stateConflict('compact continuation receipt unavailable');
  const original = HarnessR3SnapshotSchema.parse(row.pause_snapshot);
  const snapshot = HarnessR3SnapshotSchema.parse(row.snapshot);
  const context = HarnessR3ContextSchema.parse(row.context);
  const tokens = row.usage_tokens === null ? null : Number(row.usage_tokens);
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0))
    throw stateConflict('invalid compact usage');
  const expectedTokens =
    original.usage.tokens === null || (row.call_started && tokens === null)
      ? null
      : original.usage.tokens + (row.call_started ? tokens! : 0);
  const expected = {
    ...original,
    usage: {
      iterations: original.usage.iterations + (row.call_started ? 1 : 0),
      tokens: expectedTokens,
    },
  };
  if (
    routingIdentity(snapshot) !== routingIdentity(expected) ||
    (row.status === 'published'
      ? context.summary?.id !== row.summary_id
      : routingIdentity(context) !== routingIdentity(original.context))
  )
    throw stateConflict('compact continuation receipt conflict');
  await validateR3SnapshotContext(client, binding, snapshot);
  await validateR3SnapshotContext(client, binding, { ...snapshot, context });
  return { snapshot, context };
}

/** Reconstruct a continuation only from the locked pause, immutable admission
 * and published facts. Caller owns the transaction and must recheck lifecycle,
 * grants and final request capacity in guard before consuming the pause. */
export async function readCompactContinuation(
  client: PoolClient,
  binding: CompactBinding,
  userMessageId: string | null,
  budget: { maxIterations: number; maxTokens: number },
  guard: (client: PoolClient) => Promise<void>,
): Promise<{ snapshot: HarnessR3Snapshot; context: HarnessR3Context }> {
  await assertCompactEligibility(client, binding, guard);
  const row = (
    await client.query<{
      snapshot: unknown;
      status: string;
      purpose: string;
      summary_id: string | null;
      call_started: boolean;
      usage_recorded: boolean;
      usage_tokens: string | null;
      candidate_status: string;
    }>(
      `SELECT p.snapshot,p.purpose,o.status,o.summary_id,o.call_started,o.usage_recorded,o.usage_tokens::text,o.candidate_status
       FROM harness_pauses p JOIN compact_operations o ON o.pause_id=p.id
       WHERE p.id=$1 AND p.owner_id=$2 AND p.conversation_id=$3 AND p.run_id=$4 AND p.attempt_id=$5
       FOR UPDATE OF o`,
      [binding.pauseId, binding.ownerId, binding.conversationId, binding.runId, binding.attemptId],
    )
  ).rows[0];
  if (
    !row ||
    !['published', 'failed'].includes(row.status) ||
    (userMessageId === null && row.status !== 'published') ||
    // A failed automatic operation has no measured proof that the original
    // candidate still meets every continuation gate. Never silently fall back.
    (row.purpose === 'automatic_compact' && row.status === 'failed') ||
    (row.call_started && !row.usage_recorded) ||
    (row.status === 'published' && !['saved', 'failed'].includes(row.candidate_status))
  )
    throw stateConflict('compact operation is not ready to continue');
  const snapshot = HarnessR3SnapshotSchema.parse(row.snapshot);
  if (snapshot.waiting) throw stateConflict('compact cannot consume approval waiting');
  const admission =
    userMessageId === null
      ? await readR3ControlContext(client, binding)
      : await readR3Context(client, { ...binding, userMessageId });
  await validateR3SnapshotContext(client, { ...binding, userMessageId }, snapshot);
  const iterations = snapshot.usage.iterations + (row.call_started ? 1 : 0);
  const charged = row.usage_tokens === null ? null : Number(row.usage_tokens);
  if (charged !== null && (!Number.isSafeInteger(charged) || charged < 0))
    throw stateConflict('invalid compact usage');
  const tokens =
    snapshot.usage.tokens === null || (row.call_started && charged === null)
      ? null
      : snapshot.usage.tokens + (row.call_started ? charged! : 0);
  if (!Number.isSafeInteger(iterations) || (tokens !== null && !Number.isSafeInteger(tokens)))
    throw stateConflict('compact cumulative usage overflow');
  if (iterations >= budget.maxIterations || (tokens !== null && tokens >= budget.maxTokens))
    throw new HttpError(429, 429, 'BUDGET_EXCEEDED', '原运行预算已用完，不能继续。');
  let context = snapshot.context;
  if (row.status === 'published') {
    if (!row.summary_id) throw stateConflict('published compact summary missing');
    const summary = (
      await client.query<{ id: string; revision: string; text: string }>(
        `SELECT id,revision::text,summary_text AS text FROM compact_summaries
       WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 AND freeze_id=(SELECT freeze_id FROM compact_operations WHERE pause_id=$4)`,
        [row.summary_id, binding.ownerId, binding.conversationId, binding.pauseId],
      )
    ).rows[0];
    if (!summary) throw stateConflict('published compact summary unavailable');
    const ids = (
      await client.query<{ message_id: string }>(
        'SELECT message_id FROM compact_summary_sources WHERE summary_id=$1 ORDER BY position',
        [summary.id],
      )
    ).rows.map((source) => source.message_id);
    await validateCompactSources(client, {
      ownerId: binding.ownerId,
      conversationId: binding.conversationId,
      summaryId: summary.id,
      messageIds: ids,
    });
    const coverage = new Set(ids);
    const expected = admission.manifest.message_ids.filter((id) => coverage.has(id));
    if (
      expected.length !== ids.length ||
      expected.some((id, i) => id !== ids[i]) ||
      snapshot.context.summary?.message_ids.some((id) => !coverage.has(id))
    )
      throw stateConflict('compact continuation coverage conflict');
    context = HarnessR3ContextSchema.parse({
      ...snapshot.context,
      summary: { ...summary, message_ids: ids },
      messages: snapshot.context.messages.filter((message) => !coverage.has(message.message_id)),
    });
  }
  return {
    snapshot: HarnessR3SnapshotSchema.parse({ ...snapshot, usage: { iterations, tokens } }),
    context,
  };
}
