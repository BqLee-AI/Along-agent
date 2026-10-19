// Ack phase: ACK_UNKNOWN 只核对 (reconcile only, never resend). Re-checks
// acked_unknown rows against the local notice table on the 30s/2min/5min
// schedule: a found sent notice completes the fired transition; an
// exhausted schedule marks failed_deadline (persistent reconciliation
// marker); otherwise the next check is re-armed.
import { ackDelayForCheck } from '@along/scheduler-core';
import { sendKeyFor } from '@along/scheduler-core';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../../db/transaction.js';
import {
  appendTaskEvent,
  listDueAckRows,
  lockOutboxRow,
  lockTaskRow,
  markOutboxAckUnknown,
  markOutboxDispatched,
  markOutboxFailedDeadline,
  markOutboxSuperseded,
  transitionTask,
  type OutboxRow,
} from './scheduler-repository.js';

export const ACK_BATCH_LIMIT = 50;

export interface AckSummary {
  scanned: number;
  confirmed: number;
  rearmed: number;
  exhausted: number;
  superseded: number;
}

async function ackOne(
  client: PoolClient,
  row: OutboxRow,
  nowMs: number,
): Promise<keyof Omit<AckSummary, 'scanned'>> {
  const command = row.command as Record<string, unknown> | null;
  if (!command || command.kind !== 'send' || typeof command.task_id !== 'string') {
    await markOutboxSuperseded(client, row.id);
    return 'superseded';
  }
  const task = await lockTaskRow(client, command.task_id);
  if (!task) {
    await markOutboxSuperseded(client, row.id);
    return 'superseded';
  }
  if (task.state === 'cancel_pending' || task.state === 'cancelled') {
    await markOutboxSuperseded(client, row.id);
    return 'superseded';
  }
  if (task.state !== 'scheduled') {
    await markOutboxSuperseded(client, row.id);
    return 'superseded';
  }
  // Reconcile: look for the notice this send would have written. Never resend.
  const key = sendKeyFor(task.id, task.fire_at_utc.toISOString());
  const { rows } = await client.query<{ status: string }>(
    'SELECT status FROM notifications WHERE idempotency_key = $1',
    [key],
  );
  const notice = rows[0] ?? null;
  if (notice?.status === 'sent') {
    const moved = await transitionTask(client, {
      taskId: task.id,
      fromStates: ['scheduled'],
      toState: 'fired',
      expectedVersion: task.state_version,
    });
    if (!moved) {
      await markOutboxSuperseded(client, row.id);
      return 'superseded';
    }
    await appendTaskEvent(client, {
      ownerId: task.owner_id,
      taskId: task.id,
      stateVersion: task.state_version + 1,
      type: 'fired',
      evidenceRef: row.provider_receipt_id ?? key,
    });
    await markOutboxDispatched(client, row.id, row.provider_receipt_id);
    return 'confirmed';
  }
  const nextDelay = ackDelayForCheck(row.ack_check_no);
  if (nextDelay === null) {
    await markOutboxFailedDeadline(client, row.id, 'ack_unknown checks exhausted');
    return 'exhausted';
  }
  await markOutboxAckUnknown(client, {
    outboxId: row.id,
    ackCheckNo: row.ack_check_no + 1,
    nextCheckAt: new Date(nowMs + nextDelay),
    lastError: 'ack_unknown recheck',
  });
  return 'rearmed';
}

export async function runAckPhase(pool: Pool, nowMs: number = Date.now()): Promise<AckSummary> {
  const summary: AckSummary = {
    scanned: 0,
    confirmed: 0,
    rearmed: 0,
    exhausted: 0,
    superseded: 0,
  };
  const client = await pool.connect();
  let rows: OutboxRow[];
  try {
    rows = await listDueAckRows(client, ACK_BATCH_LIMIT);
  } finally {
    client.release();
  }
  for (const row of rows) {
    const disposition = await withTransaction(pool, async (txn: PoolClient) => {
      // Same lock order as sendOne (task before outbox): probe unlocked,
      // take the task lock, then lock the ack row. See runSendPhase.
      const probe = await txn.query<{ status: string }>('SELECT status FROM outbox WHERE id = $1', [
        row.id,
      ]);
      if (!probe.rows[0] || probe.rows[0].status !== 'acked_unknown') return null;
      await txn.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [row.task_id]);
      const locked = await lockOutboxRow(txn, row.id);
      if (!locked || locked.status !== 'acked_unknown') return null;
      return ackOne(txn, locked, nowMs);
    });
    if (!disposition) continue;
    summary.scanned += 1;
    if (disposition === 'confirmed') summary.confirmed += 1;
    else if (disposition === 'rearmed') summary.rearmed += 1;
    else if (disposition === 'exhausted') summary.exhausted += 1;
    else if (disposition === 'superseded') summary.superseded += 1;
  }
  return summary;
}
