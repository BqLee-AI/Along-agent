import type { PoolClient } from 'pg';
import { forbidden, notFound, stateConflict } from '../../../platform/errors.js';
import { isActiveOwner } from '../../identity/public.js';
import { lockUsableRunModel } from '../../model-providers/public.js';
import { lockRun } from '../run/repository.js';
import type { RunAuthority } from '../contracts.js';

export interface CompactBinding {
  ownerId: string;
  conversationId: string;
  runId: string;
  attemptId: string;
  pauseId: string;
  ownership?: RunAuthority;
}

type Guard = (client: PoolClient, messageIds: readonly string[]) => Promise<void>;
/** Caller owns BEGIN/COMMIT/ROLLBACK. Never perform model I/O in this transaction.
 * Lock order: attempt -> Run -> owner/model/pause -> conversation. All admission,
 * visible message insertion and compact view selection must lock that same owner-
 * scoped conversation row before reading/inserting messages; cancellation must use
 * the attempt/Run lock path. The guard must verify these IDs against the paused
 * runtime snapshot's protected input/task/tool/approval state as well as current
 * resource grants, lifecycle and cumulative budget under appropriate locks.
 */
export async function lockCompactAuthority(
  client: PoolClient,
  binding: CompactBinding,
  guard: Guard,
  messageIds: readonly string[],
): Promise<string> {
  const locked = await lockRun(client, binding, false, false);
  if (!(await isActiveOwner(client, binding.ownerId, { lock: 'share' })))
    throw forbidden('compact owner unavailable');
  const frozenContext = locked.run.frozen_context;
  if (
    locked.run.execution !== 'harness' ||
    locked.run.status !== 'paused' ||
    locked.attempt.status !== 'done' ||
    !frozenContext ||
    (frozenContext.execution_profile as string | undefined) !== 'compact-memory/1' ||
    (locked.run.input_message_id === null && frozenContext.execution_lifecycle !== 'server-owned')
  )
    throw stateConflict('compact Run is not eligible');
  if (frozenContext.execution_lifecycle === 'server-owned') {
    if (!binding.ownership) throw stateConflict('Run ownership required');
    await binding.ownership.assert(client, binding.runId, binding.attemptId);
  }
  const modelId = await lockUsableRunModel(client, binding.ownerId, binding.runId);
  if (modelId === null) throw stateConflict('frozen model binding unavailable');
  const pause = await client.query(
    `SELECT 1 FROM harness_pauses WHERE id=$1 AND owner_id=$2 AND conversation_id=$3
      AND run_id=$4 AND attempt_id=$5 AND state='paused' AND reason='runtime'
      AND purpose IN ('manual_compact','automatic_compact') AND resume_source='runtime'
      AND ($6::boolean OR purpose='manual_compact') FOR UPDATE`,
    [
      binding.pauseId,
      binding.ownerId,
      binding.conversationId,
      binding.runId,
      binding.attemptId,
      locked.run.input_message_id !== null,
    ],
  );
  if (!pause.rowCount) throw stateConflict('compact pause unavailable');
  if (locked.run.input_message_id === null) {
    const control = await client.query(
      `SELECT 1 FROM idle_compact_requests WHERE owner_id=$1 AND conversation_id=$2 AND run_id=$3 FOR SHARE`,
      [binding.ownerId, binding.conversationId, binding.runId],
    );
    if (!control.rowCount) throw stateConflict('idle compact control not admitted');
  }
  await guard(client, messageIds);
  const conversation = await client.query(
    `SELECT 1 FROM conversations WHERE id=$1 AND owner_id=$2 AND status='open' FOR UPDATE`,
    [binding.conversationId, binding.ownerId],
  );
  if (!conversation.rowCount) throw notFound('compact conversation unavailable');
  return modelId;
}
