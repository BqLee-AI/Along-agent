import { expect } from 'bun:test';
import type { Pool } from 'pg';
import { getTaskDetail } from '../../src/features/tasks/service.js';
import { runClaimPhase } from '../../src/features/tasks/scheduler/claim.js';
import { runSendPhase } from '../../src/features/tasks/scheduler/send.js';
import type { InAppProvider } from '../../src/features/notifications/service.js';

// Drive and assert only the requested task: phase summaries can include other
// tasks created earlier in the same file's isolated fixture.
export async function driveClaimUntilLeased(
  pool: Pool,
  taskId: string,
  workerId: string,
  attempts = 15,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    await runClaimPhase(pool, workerId);
    const { rows } = await pool.query('SELECT lease_owner FROM task_leases WHERE task_id = $1', [
      taskId,
    ]);
    if (rows[0]) return;
  }
  const { rows } = await pool.query('SELECT lease_owner FROM task_leases WHERE task_id = $1', [
    taskId,
  ]);
  expect(rows[0]).toBeTruthy();
}

export async function driveSendUntilFired(
  pool: Pool,
  provider: InAppProvider,
  taskId: string,
  ownerId: string,
  attempts = 15,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    await runSendPhase(pool, provider);
    const detail = await getTaskDetail({ pool }, ownerId, taskId);
    if (detail.state === 'fired') return;
  }
  const detail = await getTaskDetail({ pool }, ownerId, taskId);
  expect(detail.state).toBe('fired');
}
