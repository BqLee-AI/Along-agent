import type { PoolClient } from 'pg';
import { stateConflict } from '../../../platform/errors.js';
import { isActiveOwner } from '../../identity/public.js';
import { lockRun } from '../run/repository.js';
import type { CompactBinding } from './compact-eligibility.js';

/** All functions use a caller-owned short transaction. No model I/O is allowed
 * while holding these locks. Cancellation takes the same attempt -> Run -> pause
 * -> operation locks. The guard must recheck current grants and lifecycle. */
export async function assertCompactEligibility(
  client: PoolClient,
  binding: CompactBinding,
  guard: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const locked = await lockRun(client, binding, false, false);
  if (
    locked.run.status !== 'paused' ||
    locked.attempt.status !== 'done' ||
    !(await isActiveOwner(client, binding.ownerId, { lock: 'share' }))
  )
    throw stateConflict('compact Run is not eligible');
  if (locked.run.frozen_context?.execution_lifecycle === 'server-owned') {
    if (!binding.ownership) throw stateConflict('Run ownership required');
    await binding.ownership.assert(client, binding.runId, binding.attemptId);
  }
  const pause = await client.query(
    `SELECT 1 FROM harness_pauses WHERE id=$1 AND owner_id=$2 AND conversation_id=$3
     AND run_id=$4 AND attempt_id=$5 AND state='paused' AND reason='runtime'
     AND purpose IN ('manual_compact','automatic_compact') AND resume_source='runtime' FOR UPDATE`,
    [binding.pauseId, binding.ownerId, binding.conversationId, binding.runId, binding.attemptId],
  );
  if (!pause.rowCount) throw stateConflict('compact pause unavailable');
  await guard(client);
}

/** Reserve exactly one iteration before external model I/O. A crash after this
 * commit leaves a conservatively charged call with unknown token usage. The guard
 * must validate the frozen budget, capacity and model binding for this call. */
export async function beginCompactCall(
  client: PoolClient,
  binding: CompactBinding,
  freezeId: string,
  guard: (client: PoolClient) => Promise<void>,
): Promise<void> {
  await assertCompactEligibility(client, binding, guard);
  const result = await client.query(
    `UPDATE compact_operations o SET status='running',freeze_id=$6,call_started=true,updated_at=now()
     WHERE o.pause_id=$1 AND o.owner_id=$2 AND o.conversation_id=$3 AND o.run_id=$4 AND o.attempt_id=$5
       AND o.status='pending' AND NOT o.call_started
       AND EXISTS (SELECT 1 FROM compact_freezes f WHERE f.id=$6 AND f.pause_id=o.pause_id
         AND f.owner_id=o.owner_id AND f.conversation_id=o.conversation_id
         AND f.run_id=o.run_id AND f.attempt_id=o.attempt_id)`,
    [
      binding.pauseId,
      binding.ownerId,
      binding.conversationId,
      binding.runId,
      binding.attemptId,
      freezeId,
    ],
  );
  if (!result.rowCount) throw stateConflict('compact call already started or freeze unavailable');
}

/** Account for a reserved call even after cancellation or loss of eligibility.
 * Lock the original attempt and Run, but do not require it still be latest: a
 * late provider result must never be silently dropped. Null is unknown, not zero. */
export async function recordCompactUsage(
  client: PoolClient,
  binding: CompactBinding,
  tokens: number | null,
): Promise<void> {
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0))
    throw stateConflict('invalid compact usage');
  const attempt = await client.query(
    'SELECT 1 FROM run_attempts WHERE id=$1 AND owner_id=$2 AND run_id=$3 FOR UPDATE',
    [binding.attemptId, binding.ownerId, binding.runId],
  );
  const run = await client.query(
    'SELECT 1 FROM agent_runs WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 FOR UPDATE',
    [binding.runId, binding.ownerId, binding.conversationId],
  );
  if (!attempt.rowCount || !run.rowCount)
    throw stateConflict('compact accounting binding unavailable');
  await client.query('SELECT 1 FROM harness_pauses WHERE id=$1 FOR UPDATE', [binding.pauseId]);
  const operation = (
    await client.query<{
      call_started: boolean;
      usage_recorded: boolean;
      usage_tokens: string | null;
    }>(
      `SELECT call_started,usage_recorded,usage_tokens::text FROM compact_operations
     WHERE pause_id=$1 AND owner_id=$2 AND conversation_id=$3 AND run_id=$4 AND attempt_id=$5 FOR UPDATE`,
      [binding.pauseId, binding.ownerId, binding.conversationId, binding.runId, binding.attemptId],
    )
  ).rows[0];
  if (!operation?.call_started) throw stateConflict('compact call was not reserved');
  if (operation.usage_recorded) {
    if (operation.usage_tokens !== (tokens === null ? null : String(tokens)))
      throw stateConflict('compact usage already recorded differently');
    return;
  }
  await client.query(
    'UPDATE compact_operations SET usage_recorded=true,usage_tokens=$2,updated_at=now() WHERE pause_id=$1',
    [binding.pauseId, tokens],
  );
}

/** Record failure even if authorization was revoked, without replacing cancellation. */
export async function failCompact(
  client: PoolClient,
  binding: CompactBinding,
  code: string,
): Promise<void> {
  if (!code || code.length > 128) throw stateConflict('invalid compact failure');
  const attempt = await client.query(
    'SELECT 1 FROM run_attempts WHERE id=$1 AND owner_id=$2 AND run_id=$3 FOR UPDATE',
    [binding.attemptId, binding.ownerId, binding.runId],
  );
  const run = await client.query(
    'SELECT 1 FROM agent_runs WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 FOR UPDATE',
    [binding.runId, binding.ownerId, binding.conversationId],
  );
  if (!attempt.rowCount || !run.rowCount)
    throw stateConflict('compact accounting binding unavailable');
  await client.query('SELECT 1 FROM harness_pauses WHERE id=$1 FOR UPDATE', [binding.pauseId]);
  const result = await client.query(
    `UPDATE compact_operations SET status='failed',error_code=$6,updated_at=now()
     WHERE pause_id=$1 AND owner_id=$2 AND conversation_id=$3 AND run_id=$4 AND attempt_id=$5
       AND status IN ('pending','running') AND (NOT call_started OR usage_recorded)`,
    [
      binding.pauseId,
      binding.ownerId,
      binding.conversationId,
      binding.runId,
      binding.attemptId,
      code,
    ],
  );
  if (!result.rowCount) throw stateConflict('compact operation cannot fail');
}

/** Called in the same transaction as publishCompact; its CAS and source checks
 * must complete before this state change, and rollback includes both writes. */
export async function markCompactPublished(
  client: PoolClient,
  binding: CompactBinding,
  freezeId: string,
  summaryId: string,
  guard: (client: PoolClient) => Promise<void>,
): Promise<void> {
  await assertCompactEligibility(client, binding, guard);
  const result = await client.query(
    `UPDATE compact_operations o SET status='published',summary_id=$7,updated_at=now()
     WHERE o.pause_id=$1 AND o.owner_id=$2 AND o.conversation_id=$3 AND o.run_id=$4 AND o.attempt_id=$5
       AND o.freeze_id=$6 AND o.status='running' AND o.call_started AND o.usage_recorded
       AND EXISTS (SELECT 1 FROM compact_summaries s WHERE s.id=$7 AND s.freeze_id=o.freeze_id
         AND s.owner_id=o.owner_id AND s.conversation_id=o.conversation_id)`,
    [
      binding.pauseId,
      binding.ownerId,
      binding.conversationId,
      binding.runId,
      binding.attemptId,
      freezeId,
      summaryId,
    ],
  );
  if (!result.rowCount) throw stateConflict('compact operation cannot publish');
}

/** Candidate writes and this receipt belong to the same transaction; source
 * validation and every actual memory insert must have completed first. */
export async function finishCompactCandidates(
  client: PoolClient,
  binding: CompactBinding,
  summaryId: string,
  result: { saved: number; failed: number; errorCode?: string },
  guard: (client: PoolClient) => Promise<void>,
): Promise<void> {
  if (
    !Number.isSafeInteger(result.saved) ||
    result.saved < 0 ||
    !Number.isSafeInteger(result.failed) ||
    result.failed < 0 ||
    (result.failed > 0 && (!result.errorCode || result.errorCode.length > 128)) ||
    (result.failed === 0 && result.errorCode !== undefined)
  )
    throw stateConflict('invalid compact candidate receipt');
  await assertCompactEligibility(client, binding, guard);
  const updated = await client.query(
    `UPDATE compact_operations SET candidate_status=$7,candidate_error_code=$8,
      candidate_saved_count=$9,candidate_failed_count=$10,updated_at=now()
     WHERE pause_id=$1 AND owner_id=$2 AND conversation_id=$3 AND run_id=$4 AND attempt_id=$5
       AND summary_id=$6 AND status='published' AND candidate_status='pending'`,
    [
      binding.pauseId,
      binding.ownerId,
      binding.conversationId,
      binding.runId,
      binding.attemptId,
      summaryId,
      result.failed ? 'failed' : 'saved',
      result.errorCode ?? null,
      result.saved,
      result.failed,
    ],
  );
  if (!updated.rowCount) throw stateConflict('compact candidate receipt unavailable');
}

/** A candidate transaction may fail after summary publication. Persist that
 * failure without requiring still-active authorization; cancellation wins. */
export async function failCompactCandidates(
  client: PoolClient,
  binding: CompactBinding,
  summaryId: string,
  code: string,
): Promise<boolean> {
  if (!code || code.length > 128) throw stateConflict('invalid compact candidate failure');
  const attempt = await client.query(
    'SELECT 1 FROM run_attempts WHERE id=$1 AND owner_id=$2 AND run_id=$3 FOR UPDATE',
    [binding.attemptId, binding.ownerId, binding.runId],
  );
  const run = await client.query(
    'SELECT 1 FROM agent_runs WHERE id=$1 AND owner_id=$2 AND conversation_id=$3 FOR UPDATE',
    [binding.runId, binding.ownerId, binding.conversationId],
  );
  if (!attempt.rowCount || !run.rowCount)
    throw stateConflict('compact accounting binding unavailable');
  await client.query('SELECT 1 FROM harness_pauses WHERE id=$1 FOR UPDATE', [binding.pauseId]);
  const result = await client.query(
    `UPDATE compact_operations SET candidate_status='failed',candidate_error_code=$7,
       candidate_failed_count=1,updated_at=now()
     WHERE pause_id=$1 AND owner_id=$2 AND conversation_id=$3 AND run_id=$4 AND attempt_id=$5
       AND summary_id=$6 AND status='published' AND candidate_status='pending'`,
    [
      binding.pauseId,
      binding.ownerId,
      binding.conversationId,
      binding.runId,
      binding.attemptId,
      summaryId,
      code,
    ],
  );
  return !!result.rowCount;
}
