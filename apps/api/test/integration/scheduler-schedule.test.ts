// Scheduler happy path: confirm -> schedule phase -> claim -> send -> fired.
// Seeds via the approvals confirm path (same as approvals-confirm.test.ts),
// then drives each worker phase directly. Fire time is chosen seconds in the
// future so no sleep is needed: claim/send run after manually nudging
// fire_at_utc into the past with a DB timestamp update (deterministic, no
// sleep, no flakiness).
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { confirmApproval } from '../../src/features/approvals/reminder/confirm.js';
import { getApprovalDetail } from '../../src/features/approvals/reminder/service.js';
import { getTaskDetail } from '../../src/features/tasks/read/queries.js';
import { runSchedulePhase } from '../../src/features/tasks/scheduler/schedule.js';
import { runSendPhase } from '../../src/features/tasks/scheduler/send.js';
import {
  createLocalInAppProvider,
  type InAppProvider,
} from '../../src/features/notifications/service.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
  seedApproval,
} from './setup.js';
import { driveClaimUntilLeased, driveSendUntilFired } from './scheduler-drivers.js';

const maybe = databaseUrl ? describe : describe.skip;

async function confirmTask(
  pool: Pool,
  ownerId?: string,
): Promise<{ taskId: string; ownerId: string }> {
  const seed = await seedApproval(pool, ownerId ? { ownerId } : {});
  const { detail } = await getApprovalDetail({ pool }, seed.ownerId, seed.id);
  const result = await confirmApproval({ pool }, seed.ownerId, seed.id, {
    presentation_hash: seed.presentationHash,
    seen_content: detail.echo_text,
    idempotency_key: randomUUID(),
  });
  return { taskId: result.task_id, ownerId: seed.ownerId };
}

// Assert this task's outcome rather than a whole-phase summary, which can
// include other tasks created earlier in this file's fixture.
async function runScheduleUntil(
  pool: Pool,
  taskId: string,
  ownerId: string,
  attempts = 10,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    await runSchedulePhase(pool);
    const detail = await getTaskDetail({ pool }, ownerId, taskId);
    if (detail.state === 'scheduled') return;
    const { rows } = await pool.query(
      "SELECT status FROM outbox WHERE task_id = $1 AND command->>'kind' = 'schedule'",
      [taskId],
    );
    // superseded rows never become scheduled: surface immediately.
    if (rows.some((r) => r.status === 'superseded' || r.status === 'failed_deadline')) return;
  }
  const detail = await getTaskDetail({ pool }, ownerId, taskId);
  expect(detail.state).toBe('scheduled');
}
maybe('scheduler schedule/claim/send', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  let receivePool: Pool;
  let provider: InAppProvider;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
    receivePool = new Pool({ ...pool.options, max: 1 });
    provider = createLocalInAppProvider(receivePool);
  });
  afterAll(async () => {
    try {
      await receivePool?.end();
    } finally {
      await database?.close();
    }
  });

  it('registers, claims and fires exactly one notice', async () => {
    const { taskId, ownerId } = await confirmTask(pool);

    // Schedule: outbox kind=schedule -> task scheduled + receipt + event.
    await runScheduleUntil(pool, taskId, ownerId);
    let detail = await getTaskDetail({ pool }, ownerId, taskId);
    expect(detail.state).toBe('scheduled');
    expect(detail.schedule_receipt).toBe(`sched:${taskId}`);

    // Nudge fire_at into the past (deterministic; no sleep).
    await pool.query("UPDATE tasks SET fire_at_utc = now() - interval '10 seconds' WHERE id = $1", [
      taskId,
    ]);

    // Claim: lease row appears with this worker as owner.
    await driveClaimUntilLeased(pool, taskId, 'worker-test-1');
    const { rows: leases } = await pool.query(
      'SELECT lease_owner FROM task_leases WHERE task_id = $1',
      [taskId],
    );
    expect(leases[0]?.lease_owner).toBe('worker-test-1');

    // Send: gate passes, one notice, task fired + fired event.
    await driveSendUntilFired(pool, provider, taskId, ownerId);
    detail = await getTaskDetail({ pool }, ownerId, taskId);
    expect(detail.state).toBe('fired');

    const { rows: notices } = await pool.query(
      'SELECT count(*) AS n FROM notifications WHERE task_id = $1',
      [taskId],
    );
    expect(Number(notices[0]?.n)).toBe(1);
    const { rows: events } = await pool.query(
      'SELECT type FROM task_events WHERE task_id = $1 ORDER BY recorded_at_utc ASC',
      [taskId],
    );
    expect(events.map((e) => e.type)).toEqual(['created', 'scheduled', 'fired']);

    // A repeated send scan does not double-fire.
    await runSendPhase(pool, provider);
    const { rows: firedAgain } = await pool.query(
      "SELECT count(*) AS n FROM task_events WHERE task_id = $1 AND type = 'fired'",
      [taskId],
    );
    expect(Number(firedAgain[0]?.n)).toBe(1);
    const { rows: notices2 } = await pool.query(
      'SELECT count(*) AS n FROM notifications WHERE task_id = $1',
      [taskId],
    );
    expect(Number(notices2[0]?.n)).toBe(1);
  });

  it('supersedes schedule rows whose version drifted', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    // Drift the task version before the schedule phase runs.
    await pool.query(
      "UPDATE tasks SET state_version = state_version + 1, state = 'pending_schedule' WHERE id = $1",
      [taskId],
    );
    // Assert the task-scoped outcome, not the global phase summary.
    for (let i = 0; i < 10; i += 1) {
      await runSchedulePhase(pool);
      const { rows: probe } = await pool.query(
        "SELECT status FROM outbox WHERE task_id = $1 AND command->>'kind' = 'schedule'",
        [taskId],
      );
      if (probe[0]?.status === 'superseded' || probe[0]?.status === 'failed_deadline') break;
    }
    const { rows: outbox } = await pool.query(
      "SELECT status FROM outbox WHERE task_id = $1 AND command->>'kind' = 'schedule'",
      [taskId],
    );
    expect(outbox[0]?.status).toBe('superseded');
    const detail = await getTaskDetail({ pool }, ownerId, taskId);
    expect(detail.state).not.toBe('scheduled');
    void detail;
  });
});
