// Cancel submission commits cancel_pending, its event and a durable command.
// Old queued work is fenced immediately. Only a persisted PG queue-revocation
// receipt can finish cancellation; otherwise the production worker does it.
//
// No token plaintext is stored; the idempotency key is the caller's uuid.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../../db/transaction.js';
import {
  forbidden,
  notFound,
  notReady,
  stateConflict,
  validationError,
  type ApplicationError,
} from '../../../platform/errors.js';
import {
  completeCancelFromReceipt,
  supersedeStaleTaskWork,
} from '../scheduler/scheduler-repository.js';
import { appendTaskEvent } from '../task-event-ledger.js';
import { findCancelRowByKey, insertCancelCommand, lockTaskForCancel } from './cancel-repository.js';

export const CancelBodySchema = z.object({
  reason: z.string().max(2000).optional(),
  idempotency_key: z.string().uuid(),
});

export type CancelBody = z.infer<typeof CancelBodySchema>;

export interface CancelDeps {
  pool: Pool | null;
}

export interface CancelResult {
  task_id: string;
  state: string;
  duplicate: boolean;
}

function cancelKey(ownerId: string, taskId: string, key: string): string {
  return `cancel:${ownerId}:${taskId}:${key}`;
}

export interface CancelWithinTxArgs {
  ownerId: string;
  taskId: string;
  reason: string | null;
  idempotencyKey: string;
}

// The cancel state transition without opening a transaction. Used by
// POST /tasks/{id}/actions/cancel and by the approvals confirm gate for
// cancel_task approvals (the one sanctioned cross-module transaction: approval
// consume + cancel request commit together). Callers MUST already hold a
// transaction; the row lock is taken here.
export async function cancelTaskWithinTransaction(
  client: PoolClient,
  args: CancelWithinTxArgs,
): Promise<CancelResult> {
  const row = await lockTaskForCancel(client, args.taskId);
  if (!row) throw notFound('task not found');
  if (row.owner_id !== args.ownerId) throw forbidden('task not found');
  // Terminal states: fired/missed cannot be cancelled.
  if (row.state === 'fired' || row.state === 'missed') {
    throw stateConflict('task already fired or missed', {
      current_state: row.state,
    }) as ApplicationError;
  }
  if (row.state === 'cancelled') {
    return { task_id: row.id, state: 'cancelled', duplicate: true };
  }
  if (row.state === 'cancel_pending') {
    // Same key replays; a new key tops up the cancel command row.
    const existing = await findCancelRowByKey(client, args.idempotencyKey);
    if (!existing) {
      const { rows: fireRows } = await client.query<{ fire_at_utc: Date }>(
        'SELECT fire_at_utc FROM tasks WHERE id = $1',
        [row.id],
      );
      await insertCancelCommand(client, {
        ownerId: args.ownerId,
        taskId: row.id,
        expectedStateVersion: row.state_version,
        fireAtIso: (fireRows[0]?.fire_at_utc ?? new Date()).toISOString(),
        idempotencyKey: args.idempotencyKey,
        reason: args.reason,
      });
    }
    const result = await finishCancelStep(client, args.ownerId, row.id, row.state_version);
    return existing ? { ...result, duplicate: true } : result;
  }

  // Step 1: move to cancel_pending + event + cancel command, same txn.
  const { rows: moved } = await client.query<{ state_version: number }>(
    `UPDATE tasks SET state = 'cancel_pending', state_version = state_version + 1
     WHERE id = $1 AND state_version = $2 AND state IN ('saved','pending_schedule','scheduled')
     RETURNING state_version`,
    [row.id, row.state_version],
  );
  if (!moved[0]) {
    throw stateConflict('task state changed during cancel') as ApplicationError;
  }
  await appendTaskEvent(client, {
    ownerId: args.ownerId,
    taskId: row.id,
    stateVersion: moved[0].state_version,
    type: 'cancel_requested',
    evidenceRef: 'local',
  });
  await supersedeStaleTaskWork(client, {
    ownerId: args.ownerId,
    taskId: row.id,
    expectedVersion: moved[0].state_version,
  });
  // Fire time is frozen on the task row; read it for the command payload.
  const { rows: fireRows } = await client.query<{ fire_at_utc: Date }>(
    'SELECT fire_at_utc FROM tasks WHERE id = $1',
    [row.id],
  );
  const fireAt = fireRows[0]?.fire_at_utc ?? new Date();
  await insertCancelCommand(client, {
    ownerId: args.ownerId,
    taskId: row.id,
    expectedStateVersion: moved[0].state_version,
    fireAtIso: fireAt.toISOString(),
    idempotencyKey: args.idempotencyKey,
    reason: args.reason,
  });
  return finishCancelStep(client, args.ownerId, row.id, moved[0].state_version);
}

export async function requestCancel(
  deps: CancelDeps,
  ownerId: string,
  taskId: string,
  body: unknown,
): Promise<CancelResult> {
  const parsed = CancelBodySchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid cancel body');
  const pool = deps.pool;
  if (!pool) throw notReady('database unavailable');
  const key = cancelKey(ownerId, taskId, parsed.data.idempotency_key);
  return withTransaction(pool, async (client: PoolClient) => {
    // Idempotency: same key replays the original cancel outcome.
    const replay = await findCancelRowByKey(client, key);
    if (replay) {
      const again = await lockTaskForCancel(client, taskId);
      if (!again) throw notFound('task not found');
      if (again.owner_id !== ownerId) throw forbidden('task not found');
      if (again.state === 'cancel_pending') {
        const result = await finishCancelStep(client, ownerId, again.id, again.state_version);
        return { ...result, duplicate: true };
      }
      if (again.state === 'cancelled') {
        return { task_id: again.id, state: again.state, duplicate: true };
      }
    }
    return cancelTaskWithinTransaction(client, {
      ownerId,
      taskId,
      reason: parsed.data.reason ?? null,
      idempotencyKey: key,
    });
  });
}

async function finishCancelStep(
  client: PoolClient,
  ownerId: string,
  taskId: string,
  version: number,
): Promise<CancelResult> {
  const completed = await completeCancelFromReceipt(client, {
    ownerId,
    taskId,
    expectedVersion: version,
  });
  return {
    task_id: taskId,
    state: completed ? 'cancelled' : 'cancel_pending',
    duplicate: false,
  };
}

export { randomUUID };
