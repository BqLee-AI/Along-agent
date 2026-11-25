// Public read-only task port for notification intake. Keep this independent
// of tasks/read/queries.ts, which consumes notifications for task-detail reads.
import type { PoolClient } from 'pg';
import { getTask } from './read/repository.js';

export interface TaskNotificationSource {
  fireAtUtc: string;
  state: string;
  stateVersion: number;
  scheduleReceipt: string | null;
  wallTime: string;
  timezoneId: string;
  originalNote: string | null;
  elapsedDisplay?: {
    fireAtUtc: string;
    offsetSeconds: number;
    anchorUtc: string;
    durationSeconds: number;
  };
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
  if (task.display_version === 'elapsed/1' && !task.time_basis) {
    throw new Error('elapsed notification missing frozen time basis');
  }
  return {
    fireAtUtc: task.fire_at_utc.toISOString(),
    state: task.state,
    stateVersion: task.state_version,
    scheduleReceipt: task.schedule_receipt,
    wallTime: task.wall_time,
    timezoneId: task.timezone_id,
    originalNote: task.original_note,
    ...(task.display_version === 'elapsed/1' && task.time_basis
      ? {
          elapsedDisplay: {
            fireAtUtc: task.fire_at_utc.toISOString(),
            offsetSeconds: task.resolved_utc_offset_seconds,
            anchorUtc: task.time_basis.anchor_utc,
            durationSeconds: task.time_basis.duration_seconds,
          },
        }
      : {}),
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
