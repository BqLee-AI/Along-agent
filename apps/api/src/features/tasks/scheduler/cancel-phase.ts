// Cancel worker: lock task before outbox, validate the cancellation fence,
// revoke PG queue work/leases, verify it, persist a receipt, then append the
// cancelled event and complete the command in the same transaction.
import { backoffMsForAttempt } from '@along/scheduler-core';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../../db/transaction.js';
import {
  bumpOutboxAttempt,
  completeCancelFromReceipt,
  listDueCancelRows,
  lockOutboxRow,
  lockTaskRow,
  markOutboxSuperseded,
  revokeLocalTaskQueue,
  type OutboxRow,
} from './scheduler-repository.js';

export const CANCEL_BATCH_LIMIT = 50;

export interface CancelPhaseSummary {
  scanned: number;
  cancelled: number;
  pending: number;
  superseded: number;
}

function parseCancelCommand(row: OutboxRow): { taskId: string; expectedVersion: number } | null {
  const command = row.command as Record<string, unknown> | null;
  if (!command || command.kind !== 'cancel') return null;
  if (typeof command.task_id !== 'string') return null;
  if (typeof command.expected_state_version !== 'number') return null;
  if (!Number.isInteger(command.expected_state_version)) return null;
  if (command.expected_state_version !== row.expected_state_version) return null;
  return { taskId: command.task_id, expectedVersion: row.expected_state_version };
}

async function cancelOne(
  client: PoolClient,
  row: OutboxRow,
  nowMs: number,
): Promise<keyof Omit<CancelPhaseSummary, 'scanned'>> {
  const parsed = parseCancelCommand(row);
  if (!parsed || parsed.taskId !== row.task_id) {
    await markOutboxSuperseded(client, row.id);
    return 'superseded';
  }
  const task = await lockTaskRow(client, parsed.taskId);
  if (
    !task ||
    task.owner_id !== row.owner_id ||
    task.state !== 'cancel_pending' ||
    task.state_version !== parsed.expectedVersion
  ) {
    await markOutboxSuperseded(client, row.id);
    return 'superseded';
  }
  const fence = {
    ownerId: task.owner_id,
    taskId: task.id,
    expectedVersion: task.state_version,
  };
  if (
    (await revokeLocalTaskQueue(client, fence, row.id)) &&
    (await completeCancelFromReceipt(client, fence))
  ) {
    return 'cancelled';
  }
  // Cancellation has no send deadline: exhausting the finite send retry
  // schedule must not strand a pending command forever. Keep polling at the
  // maximum delay until durable revocation can actually be established.
  const nextDelay = backoffMsForAttempt(row.attempt_no) ?? 300_000;
  await bumpOutboxAttempt(client, {
    outboxId: row.id,
    attemptNo: Math.min(row.attempt_no + 1, 2_147_483_647),
    nextAttemptAt: new Date(nowMs + nextDelay),
    lastError: 'local queue revocation not confirmed',
  });
  return 'pending';
}

export async function runCancelPhase(pool: Pool): Promise<CancelPhaseSummary> {
  const summary: CancelPhaseSummary = {
    scanned: 0,
    cancelled: 0,
    pending: 0,
    superseded: 0,
  };
  const client = await pool.connect();
  let rows: OutboxRow[];
  try {
    rows = await listDueCancelRows(client, CANCEL_BATCH_LIMIT);
  } finally {
    client.release();
  }
  for (const row of rows) {
    const disposition = await withTransaction(pool, async (txn: PoolClient) => {
      // Lock order (task before outbox). See runSendPhase.
      const probe = await txn.query<{ status: string }>('SELECT status FROM outbox WHERE id = $1', [
        row.id,
      ]);
      if (!probe.rows[0] || probe.rows[0].status !== 'pending') return null;
      await txn.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [row.task_id]);
      const locked = await lockOutboxRow(txn, row.id);
      if (!locked || locked.status !== 'pending') return null;
      return cancelOne(txn, locked, Date.now());
    });
    if (!disposition) continue;
    summary.scanned += 1;
    if (disposition === 'cancelled') summary.cancelled += 1;
    else if (disposition === 'pending') summary.pending += 1;
    else if (disposition === 'superseded') summary.superseded += 1;
  }
  return summary;
}
