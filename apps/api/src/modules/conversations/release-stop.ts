import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { stateConflict } from '../../http/errors.js';
import { cancelConversationRun } from './harness-authority.js';
import type { ConversationDeps } from './contracts.js';

const selectionSchema = z
  .object({
    runId: z.string().uuid(),
    idempotencyKey: z.string().uuid(),
    waiting: z
      .object({
        checkpoint: z.string().uuid().nullable(),
        invocation: z.string().uuid().nullable(),
        approval: z.string().uuid().nullable(),
      })
      .strict(),
  })
  .strict();

// Called only while the installation and deployment leases are held and all
// writers are stopped. One explicit selection can stop only its original Run.
export async function stopReleaseWaiting(deps: ConversationDeps, input: unknown) {
  const selection = selectionSchema.parse(input);
  const pool = deps.pool;
  if (!pool) throw stateConflict('database unavailable');
  const row = (
    await pool.query<{ owner_id: string; conversation_id: string; status: string }>(
      'SELECT owner_id,conversation_id,status FROM agent_runs WHERE id=$1',
      [selection.runId],
    )
  ).rows[0];
  if (!row || row.status !== 'suspended_approval')
    throw stateConflict('selected Run is not waiting');
  const result = await cancelConversationRun(
    deps,
    row.owner_id,
    row.conversation_id,
    selection.runId,
    randomUUID(),
    { idempotency_key: selection.idempotencyKey, reason: 'user_cancelled' },
    selection.waiting,
  );
  if (result.status !== 'cancelled') throw stateConflict('selected Run was not stopped');
  return {
    runId: selection.runId,
    status: result.status,
    idempotencyKey: selection.idempotencyKey,
  };
}
