import type { Pool, PoolClient } from 'pg';
import type { ContextPolicy } from '@along/contracts';
import { withTransaction } from '../../db/transaction.js';
import { ApplicationError, stateConflict } from '../../platform/errors.js';
import { createMemoryService } from '../../features/memory/public.js';
import {
  conversationMemorySources,
  freezeCompact,
  publishCompact,
  type FrozenCompact,
  type CompactBinding,
  validateCompactSources,
  assertCompactEligibility,
  beginCompactCall,
  failCompact,
  failCompactCandidates,
  finishCompactCandidates,
  markCompactPublished,
  recordCompactUsage,
} from '../../features/conversations/public.js';
import {
  requestCompactModel,
  type CompactModelInput,
  type CompactModelResult,
  type CompactModelTransport,
} from './compact-model.js';
import { withRunTransaction } from '../runtime/run-ownership.js';

export type CompactOutcome =
  | { status: 'failed'; code: string }
  | {
      status: 'published';
      summaryId: string;
      revision: string;
      candidates: { saved: number; failed: number; code?: string };
    };

/** Internal orchestration; never expose until the caller has delivered a v8
 * continuation that consumes this exact published view and accumulated usage.
 * guard rechecks current authorization, lifecycle, safe-point protection set,
 * budget and continuation capacity; it must accept both a new prefix and the
 * complete closure that publishCompact supplies. */
export async function executeCompact(input: {
  pool: Pool;
  binding: CompactBinding;
  messageIds: string[];
  promptRevision: string;
  policy: ContextPolicy;
  budget: CompactModelInput['budget'];
  transport: CompactModelTransport;
  signal: AbortSignal;
  guard: (client: PoolClient, messageIds: readonly string[]) => Promise<void>;
  validateContinuation: (
    frozen: FrozenCompact,
    result: Extract<CompactModelResult, { ok: true }>,
  ) => Promise<void>;
}): Promise<CompactOutcome> {
  const { pool, binding } = input;
  const tx = <T>(fn: (client: PoolClient) => Promise<T>) =>
    withRunTransaction(pool, binding.ownership, fn);
  const guard = (ids: readonly string[]) => (client: PoolClient) => input.guard(client, ids);
  const recordFailure = async (code: string) => {
    try {
      await withTransaction(pool, (client) => failCompact(client, binding, code));
      return code;
    } catch (error) {
      const row = (
        await pool.query<{ status: string }>(
          'SELECT status FROM compact_operations WHERE pause_id=$1 AND owner_id=$2',
          [binding.pauseId, binding.ownerId],
        )
      ).rows[0];
      if (row?.status === 'cancelled') return 'COMPACT_CANCELLED';
      throw error;
    }
  };
  let frozen: FrozenCompact;
  try {
    frozen = await tx((client) =>
      freezeCompact(
        client,
        binding,
        { messageIds: input.messageIds, promptRevision: input.promptRevision },
        input.guard,
      ),
    );
  } catch (error) {
    const code = error instanceof ApplicationError ? error.errorCode : 'COMPACT_FREEZE_FAILED';
    return { status: 'failed', code: await recordFailure(code) };
  }
  const previousIds = frozen.previous?.messageIds ?? [];
  const fullIds = frozen.coverageMessageIds;
  const positions = new Map(fullIds.map((id, sequence) => [id, sequence]));
  const result = await requestCompactModel(
    {
      messages: frozen.messages.map((message) => ({
        ...message,
        sequence: positions.get(message.id)!,
      })),
      previous: frozen.previous
        ? {
            text: frozen.previous.text,
            coverage: previousIds.map((id) => ({ id, sequence: positions.get(id)! })),
          }
        : null,
      policy: input.policy,
      selectedModelId: frozen.modelId,
      budget: input.budget,
    },
    input.transport,
    input.signal,
    () => tx((client) => assertCompactEligibility(client, binding, guard(fullIds))),
    () => tx((client) => beginCompactCall(client, binding, frozen.freezeId, guard(fullIds))),
  );
  // A commit acknowledgement may be lost after the reservation committed.
  // Read the durable fact rather than trusting the callback's return alone.
  const operation = (
    await pool.query<{ call_started: boolean }>(
      'SELECT call_started FROM compact_operations WHERE pause_id=$1 AND owner_id=$2',
      [binding.pauseId, binding.ownerId],
    )
  ).rows[0];
  if (!operation) throw stateConflict('compact operation missing');
  if (operation.call_started) {
    await withTransaction(pool, (client) =>
      recordCompactUsage(
        client,
        binding,
        result.started ? (result.usage?.total_tokens ?? null) : null,
      ),
    );
  }
  if (!result.ok) {
    return { status: 'failed', code: await recordFailure(result.code) };
  }
  try {
    await input.validateContinuation(frozen, result);
  } catch (error) {
    const code =
      error instanceof ApplicationError ? error.errorCode : 'COMPACT_CONTINUATION_UNAVAILABLE';
    return { status: 'failed', code: await recordFailure(code) };
  }
  let published: { summaryId: string; revision: string };
  try {
    published = await tx(async (client) => {
      const receipt = await publishCompact(
        client,
        binding,
        {
          freezeId: frozen.freezeId,
          text: result.text,
          messageIds: result.coverage.map((item) => item.id),
        },
        input.guard,
      );
      await markCompactPublished(
        client,
        binding,
        frozen.freezeId,
        receipt.summaryId,
        guard(fullIds),
      );
      return receipt;
    });
  } catch (error) {
    const code = error instanceof ApplicationError ? error.errorCode : 'COMPACT_PUBLISH_FAILED';
    return { status: 'failed', code: await recordFailure(code) };
  }
  const candidates = result.candidates;
  try {
    return await tx(async (client) => {
      await assertCompactEligibility(client, binding, guard(fullIds));
      const memory = createMemoryService({
        pool,
        sources: {
          validate: async (sourceClient, source) => {
            if (source.purpose !== 'compact')
              return conversationMemorySources.validate(sourceClient, source);
            if (
              source.ownerId !== binding.ownerId ||
              source.conversationId !== binding.conversationId ||
              source.summaryId !== published.summaryId
            )
              throw new Error('compact candidate source binding mismatch');
            await validateCompactSources(sourceClient, {
              ownerId: source.ownerId,
              conversationId: source.conversationId,
              summaryId: published.summaryId,
              messageIds: source.messageIds,
            });
          },
        },
      });
      let saved = 0;
      let failed = candidates.ok ? 0 : 1;
      let code: string | undefined = candidates.ok ? undefined : candidates.code;
      if (candidates.ok)
        for (const [index, candidate] of candidates.items.entries()) {
          await client.query('SAVEPOINT compact_candidate');
          try {
            await memory.rememberCompactInTransaction(client, binding.ownerId, {
              conversationId: binding.conversationId,
              summaryId: published.summaryId,
              idempotencyKey: `compact:${binding.pauseId}:${index}`,
              ...candidate,
            });
            await client.query('RELEASE SAVEPOINT compact_candidate');
            saved++;
          } catch {
            await client.query('ROLLBACK TO SAVEPOINT compact_candidate');
            await client.query('RELEASE SAVEPOINT compact_candidate');
            failed++;
            code ??= 'COMPACT_CANDIDATE_SAVE_FAILED';
          }
        }
      await finishCompactCandidates(
        client,
        binding,
        published.summaryId,
        { saved, failed, ...(code ? { errorCode: code } : {}) },
        guard(fullIds),
      );
      return {
        status: 'published' as const,
        ...published,
        candidates: { saved, failed, ...(code ? { code } : {}) },
      };
    });
  } catch (error) {
    let code =
      error instanceof ApplicationError ? error.errorCode : 'COMPACT_CANDIDATE_SAVE_FAILED';
    const recorded = await withTransaction(pool, (client) =>
      failCompactCandidates(client, binding, published.summaryId, code),
    );
    if (!recorded) {
      const row = (
        await pool.query<{ candidate_status: string }>(
          'SELECT candidate_status FROM compact_operations WHERE pause_id=$1 AND owner_id=$2',
          [binding.pauseId, binding.ownerId],
        )
      ).rows[0];
      if (row?.candidate_status !== 'cancelled')
        throw stateConflict('compact candidate failure could not be recorded');
      code = 'COMPACT_CANCELLED';
    }
    return { status: 'published', ...published, candidates: { saved: 0, failed: 1, code } };
  }
}
