// Public read-only task port for notification intake. Keep this independent
// of tasks/service.ts, which consumes notifications for task-detail reads.
import type { PoolClient } from 'pg';
import { getTask } from './repository.js';

export interface TaskNotificationSource {
  fireAtUtc: string;
  state: string;
  stateVersion: number;
  scheduleReceipt: string | null;
  wallTime: string;
  timezoneId: string;
  originalNote: string | null;
}

/** Frozen values only: no normalization, time conversion, locks, or writes. */
export async function getTaskNotificationSource(
  client: PoolClient,
  ownerId: string,
  taskId: string,
): Promise<TaskNotificationSource | null> {
  const lookup = await getTask(client, ownerId, taskId);
  if (!lookup.found || lookup.forbidden) return null;
  const task = lookup.row;
  return {
    fireAtUtc: task.fire_at_utc.toISOString(),
    state: task.state,
    stateVersion: task.state_version,
    scheduleReceipt: task.schedule_receipt,
    wallTime: task.wall_time,
    timezoneId: task.timezone_id,
    originalNote: task.original_note,
  };
}

/** The original send version survives later task transitions and disablement. */
export async function getNotificationSendVersion(
  client: PoolClient,
  ownerId: string,
  taskId: string,
  idempotencyKey: string,
): Promise<number | null> {
  const { rows } = await client.query<{ expected_state_version: number }>(
    `SELECT expected_state_version FROM outbox
     WHERE owner_id=$1 AND task_id=$2 AND idempotency_key=$3
       AND command->>'kind'='send'`,
    [ownerId, taskId, idempotencyKey],
  );
  return rows[0]?.expected_state_version ?? null;
}
