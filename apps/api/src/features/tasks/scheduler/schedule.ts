// Schedule phase: consumes durable PG schedule commands. Under task/outbox
// locks, the transaction stores the schedule receipt, state and event; PG is
// the schedule registry and survives worker process restarts.
import { FIRE_WINDOW_MS, isPastFireWindow, scheduleReceiptFor } from '@along/scheduler-core';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../../db/transaction.js';
import {
  appendTaskEvent,
  completeUnscheduledMissed,
  listDueScheduleRows,
  lockOutboxRow,
  lockTaskRow,
  markOutboxSuperseded,
  transitionTask,
  type OutboxRow,
} from './scheduler-repository.js';

export const SCHEDULE_BATCH_LIMIT = 50;

export interface ScheduleSummary {
  scanned: number;
  scheduled: number;
  superseded: number;
  failedDeadline: number;
}

interface ParsedScheduleCommand {
  taskId: string;
  expectedStateVersion: number;
}

function parseScheduleCommand(row: OutboxRow): ParsedScheduleCommand | null {
  const command = row.command as Record<string, unknown> | null;
  if (!command || command.kind !== 'schedule') return null;
  if (typeof command.task_id !== 'string') return null;
  const expected =
    typeof command.expected_state_version === 'number'
      ? command.expected_state_version
      : row.expected_state_version;
  return { taskId: command.task_id, expectedStateVersion: expected };
}

/** Store registration acknowledgement, not delivery or cancellation evidence. */
async function completeScheduleRegistration(
  client: PoolClient,
  outboxId: string,
  receipt: string | null,
): Promise<void> {
  await client.query(
    `UPDATE outbox SET status = 'dispatched', provider_receipt_id = $2,
       last_attempt_at = now(), updated_at = now()
     WHERE id = $1`,
    [outboxId, receipt],
  );
}

/** Schedule one outbox row. Returns the disposition for summary counts. */
export async function scheduleOne(
  client: PoolClient,
  row: OutboxRow,
): Promise<'scheduled' | 'superseded' | 'failed_deadline' | 'skipped'> {
  const parsed = parseScheduleCommand(row);
  if (
    !parsed ||
    parsed.taskId !== row.task_id ||
    parsed.expectedStateVersion !== row.expected_state_version
  ) {
    // Command does not bind to this row: supersede, never deliver.
    await markOutboxSuperseded(client, row.id);
    return 'superseded';
  }
  const task = await lockTaskRow(client, parsed.taskId);
  if (!task || task.owner_id !== row.owner_id) {
    await markOutboxSuperseded(client, row.id);
    return 'superseded';
  }
  if (task.state === 'cancelled' || task.state === 'cancel_pending') {
    await markOutboxSuperseded(client, row.id);
    return 'superseded';
  }
  if (task.state !== 'saved' && task.state !== 'pending_schedule') {
    // Already scheduled/fired/missed: nothing left to register.
    await completeScheduleRegistration(client, row.id, task.schedule_receipt);
    return 'skipped';
  }
  if (task.state_version !== parsed.expectedStateVersion) {
    await markOutboxSuperseded(client, row.id);
    return 'superseded';
  }
  if (isPastFireWindow(task.fire_at_utc.getTime(), Date.now())) {
    // State, event and queue terminate atomically; never invent a receipt.
    await completeUnscheduledMissed(client, task);
    return 'failed_deadline';
  }
  void FIRE_WINDOW_MS;
  const receipt = scheduleReceiptFor(task.id);
  const moved = await transitionTask(client, {
    taskId: task.id,
    fromStates: ['saved', 'pending_schedule'],
    toState: 'scheduled',
    expectedVersion: task.state_version,
    scheduleReceipt: receipt,
  });
  if (!moved) {
    await markOutboxSuperseded(client, row.id);
    return 'superseded';
  }
  await appendTaskEvent(client, {
    ownerId: task.owner_id,
    taskId: task.id,
    stateVersion: task.state_version + 1,
    type: 'scheduled',
    evidenceRef: receipt,
  });
  await completeScheduleRegistration(client, row.id, receipt);
  return 'scheduled';
}

export async function runSchedulePhase(pool: Pool): Promise<ScheduleSummary> {
  const summary: ScheduleSummary = { scanned: 0, scheduled: 0, superseded: 0, failedDeadline: 0 };
  const client = await pool.connect();
  let rows: OutboxRow[];
  try {
    rows = await listDueScheduleRows(client, SCHEDULE_BATCH_LIMIT);
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
      return scheduleOne(txn, locked);
    });
    if (!disposition) continue;
    summary.scanned += 1;
    if (disposition === 'scheduled') summary.scheduled += 1;
    else if (disposition === 'superseded') summary.superseded += 1;
    else if (disposition === 'failed_deadline') summary.failedDeadline += 1;
  }
  return summary;
}
