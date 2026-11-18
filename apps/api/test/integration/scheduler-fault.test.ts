// Deterministic PostgreSQL scheduler regressions: repeated terminal scans,
// cancel-before-fire, stale versions and expired leases. SQL time/queue
// fixtures exercise behavior; these tests are not process-kill evidence.
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { confirmApproval } from '../../src/features/approvals/reminder/confirm.js';
import { getApprovalDetail } from '../../src/features/approvals/reminder/service.js';
import { getTaskDetail } from '../../src/features/tasks/service.js';
import { requestCancel } from '../../src/features/tasks/cancellation/cancel.js';
import { runSchedulePhase } from '../../src/features/tasks/scheduler/schedule.js';
import { runSendPhase } from '../../src/features/tasks/scheduler/send.js';
import { runMissedPhase } from '../../src/features/tasks/scheduler/missed.js';
import { driveClaimUntilLeased, driveSendUntilFired } from './scheduler-drivers.js';
import { recordCancelBreach } from '../../src/features/tasks/scheduler/scheduler-repository.js';
import { runCancelPhase } from '../../src/features/tasks/scheduler/cancel-phase.js';
import { runClaimPhase } from '../../src/features/tasks/scheduler/claim.js';
import { runAckPhase } from '../../src/features/tasks/scheduler/ack.js';
import {
  createLocalInAppProvider,
  type InAppNotice,
  type InAppProvider,
} from '../../src/features/notifications/service.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
  seedApproval,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;

async function confirmTask(pool: Pool): Promise<{ taskId: string; ownerId: string }> {
  const seed = await seedApproval(pool, {});
  const { detail } = await getApprovalDetail({ pool }, seed.ownerId, seed.id);
  const result = await confirmApproval({ pool }, seed.ownerId, seed.id, {
    presentation_hash: seed.presentationHash,
    seen_content: detail.echo_text,
    idempotency_key: randomUUID(),
  });
  return { taskId: result.task_id, ownerId: seed.ownerId };
}
async function recordCancelBreachVia(pool: Pool, ownerId: string, taskId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await recordCancelBreach(client, {
      ownerId,
      taskId,
      evidenceRef: 'fault-test-breach-path',
    });
  } finally {
    client.release();
  }
}

async function scheduleAndArm(pool: Pool, taskId: string, ownerId: string): Promise<void> {
  // Assert this task even when a phase scans other tasks in this file.
  for (let i = 0; i < 10; i += 1) {
    await runSchedulePhase(pool);
    const detail = await getTaskDetail({ pool }, ownerId, taskId);
    if (detail.state === 'scheduled') break;
  }
  await pool.query("UPDATE tasks SET fire_at_utc = now() - interval '10 seconds' WHERE id = $1", [
    taskId,
  ]);
}

maybe('scheduler fault injection (F1/F2, D9)', () => {
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

  it('F1 repeated send scans preserve exactly one notice and fired event', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleAndArm(pool, taskId, ownerId);

    // Claim and complete normally, then scan the terminal task again.
    await driveClaimUntilLeased(pool, taskId, 'worker-f1-a');
    await driveSendUntilFired(pool, provider, taskId, ownerId);
    const firstDetail = await getTaskDetail({ pool }, ownerId, taskId);
    expect(firstDetail.state).toBe('fired');

    // A second scan cannot acquire a new invocation permit.
    await runSendPhase(pool, provider);

    const { rows: notices } = await pool.query(
      'SELECT count(*) AS n FROM notifications WHERE task_id = $1',
      [taskId],
    );
    expect(Number(notices[0]?.n)).toBe(1);
    const { rows: fired } = await pool.query(
      "SELECT count(*) AS n FROM task_events WHERE task_id = $1 AND type = 'fired'",
      [taskId],
    );
    expect(Number(fired[0]?.n)).toBe(1);
    const detail = await getTaskDetail({ pool }, ownerId, taskId);
    expect(detail.state).toBe('fired');
  });

  it('F2 cancel-before-fire: zero triggers after cancel commits', async () => {
    const positive = await confirmTask(pool);
    await scheduleAndArm(pool, positive.taskId, positive.ownerId);
    await driveClaimUntilLeased(pool, positive.taskId, 'worker-f2-positive');
    const calls = new Map<string, number>();
    const observingProvider = async (notice: InAppNotice) => {
      calls.set(notice.taskId, (calls.get(notice.taskId) ?? 0) + 1);
      return provider(notice);
    };
    for (let i = 0; i < 15; i += 1) {
      await runSendPhase(pool, observingProvider);
      if ((await getTaskDetail({ pool }, positive.ownerId, positive.taskId)).state === 'fired')
        break;
    }
    // Positive control wraps the real local provider, not a canned response.
    expect(calls.get(positive.taskId)).toBe(1);

    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleAndArm(pool, taskId, ownerId);
    await driveClaimUntilLeased(pool, taskId, 'worker-f2-cancelled');
    const cancel = await requestCancel({ pool }, ownerId, taskId, {
      reason: 'changed mind',
      idempotency_key: randomUUID(),
    });
    expect(cancel.state).toBe('cancel_pending');
    await runSendPhase(pool, observingProvider);
    expect(calls.get(taskId) ?? 0).toBe(0);

    for (let i = 0; i < 15; i += 1) {
      await runCancelPhase(pool);
      if ((await getTaskDetail({ pool }, ownerId, taskId)).state === 'cancelled') break;
    }
    expect((await getTaskDetail({ pool }, ownerId, taskId)).state).toBe('cancelled');
    await runCancelPhase(pool);
    await runClaimPhase(pool, 'worker-f2-after-cancel');
    // Model old worker snapshots resurfacing after cancellation. Every entry
    // point must re-check PG state/version, not trust its saved queue object.
    await pool.query(
      `UPDATE outbox SET status = 'pending', last_attempt_at = NULL
       WHERE task_id = $1 AND command->>'kind' = 'schedule'`,
      [taskId],
    );
    await runSchedulePhase(pool);
    await pool.query(
      `UPDATE outbox SET status = 'dispatched', last_attempt_at = NULL
       WHERE task_id = $1 AND command->>'kind' = 'send'`,
      [taskId],
    );
    await runSendPhase(pool, observingProvider);
    await pool.query(
      `UPDATE outbox SET status = 'acked_unknown', last_attempt_at = NULL
       WHERE task_id = $1 AND command->>'kind' = 'send'`,
      [taskId],
    );
    await runAckPhase(pool);
    await runSendPhase(pool, observingProvider);
    expect(calls.get(taskId) ?? 0).toBe(0);
    const { rows: notices } = await pool.query(
      'SELECT count(*) AS n FROM notifications WHERE task_id = $1',
      [taskId],
    );
    expect(Number(notices[0]?.n)).toBe(0);

    // D9 authoritative: cancel 提交后 firing 窗口触发数 = 0 (event ledger).
    const { rows: windowFires } = await pool.query(
      `SELECT count(*) AS n FROM task_events
       WHERE task_id = $1 AND type = 'fired'
         AND recorded_at_utc > (SELECT recorded_at_utc FROM task_events
           WHERE task_id = $1 AND type = 'cancel_requested' LIMIT 1)`,
      [taskId],
    );
    expect(Number(windowFires[0]?.n)).toBe(0);

    // Every non-cancel command is non-executable after revocation, including
    // the stale work reintroduced above.
    const { rows: queued } = await pool.query(
      `SELECT count(*) AS n FROM outbox WHERE task_id = $1
       AND command->>'kind' != 'cancel'
       AND status IN ('pending','dispatched','acked_unknown')`,
      [taskId],
    );
    expect(Number(queued[0]?.n)).toBe(0);
    const { rows: receipts } = await pool.query(
      `SELECT provider_receipt_id FROM outbox
       WHERE task_id = $1 AND command->>'kind' = 'cancel' AND status = 'dispatched'`,
      [taskId],
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].provider_receipt_id).toBeTruthy();
    const { rows: cancelledEvents } = await pool.query(
      `SELECT evidence_ref FROM task_events WHERE task_id = $1 AND type = 'cancelled'`,
      [taskId],
    );
    expect(cancelledEvents).toEqual([{ evidence_ref: receipts[0].provider_receipt_id }]);
    const { rows: actualBreaches } = await pool.query(
      "SELECT 1 FROM security_events WHERE task_id = $1 AND type = 'cancel_breach'",
      [taskId],
    );
    expect(actualBreaches).toHaveLength(0);
    // Preserve coverage of the production breach writer independently of the
    // natural cancellation path (whose actual breach count above is zero).
    await recordCancelBreachVia(pool, ownerId, taskId);
    const { rows: breaches } = await pool.query(
      "SELECT count(*) AS n FROM security_events WHERE task_id = $1 AND type = 'cancel_breach'",
      [taskId],
    );
    expect(Number(breaches[0]?.n)).toBeGreaterThanOrEqual(1);

    await pool.query("UPDATE tasks SET fire_at_utc = now() - interval '20 minutes' WHERE id = $1", [
      taskId,
    ]);
    await runMissedPhase(pool);
    await runClaimPhase(pool, 'worker-f2-past-window');
    await runSendPhase(pool, observingProvider);
    expect(calls.get(taskId) ?? 0).toBe(0);
    expect((await getTaskDetail({ pool }, ownerId, taskId)).state).toBe('cancelled');
  });

  it('old-version send and ack work cannot invoke the provider or confirm fired', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleAndArm(pool, taskId, ownerId);
    await driveClaimUntilLeased(pool, taskId, 'worker-stale-version');
    // Commit real intake without worker finalization, then model unknown work
    // as a SQL fixture. Version drift must fence both ack and later send scans.
    let calls = 0;
    const observingProvider = async (notice: InAppNotice) => {
      if (notice.taskId === taskId) calls += 1;
      return provider(notice);
    };
    const { rows: sendRows } = await pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM outbox WHERE task_id = $1 AND command->>'kind' = 'send'`,
      [taskId],
    );
    expect(sendRows).toHaveLength(1);
    await observingProvider({ ownerId, taskId, idempotencyKey: sendRows[0]!.idempotency_key });
    await pool.query(
      `UPDATE outbox SET status = 'acked_unknown', last_attempt_at = NULL
       WHERE task_id = $1 AND command->>'kind' = 'send'`,
      [taskId],
    );
    expect(calls).toBe(1);
    expect(
      (
        await pool.query(
          `SELECT status FROM outbox WHERE task_id = $1 AND command->>'kind' = 'send'`,
          [taskId],
        )
      ).rows,
    ).toEqual([{ status: 'acked_unknown' }]);
    expect(
      (await pool.query('SELECT status FROM notifications WHERE task_id = $1', [taskId])).rows,
    ).toEqual([{ status: 'sent' }]);
    await pool.query('UPDATE tasks SET state_version = state_version + 1 WHERE id = $1', [taskId]);
    await pool.query(
      `UPDATE outbox SET last_attempt_at = NULL
       WHERE task_id = $1 AND command->>'kind' = 'send'`,
      [taskId],
    );
    for (let i = 0; i < 15; i += 1) {
      await runAckPhase(pool);
      const { rows } = await pool.query(
        `SELECT status FROM outbox WHERE task_id = $1 AND command->>'kind' = 'send'`,
        [taskId],
      );
      if (rows[0]?.status === 'superseded') break;
    }
    expect((await getTaskDetail({ pool }, ownerId, taskId)).state).toBe('scheduled');
    expect(
      (
        await pool.query("SELECT 1 FROM task_events WHERE task_id = $1 AND type = 'fired'", [
          taskId,
        ])
      ).rows,
    ).toHaveLength(0);
    await pool.query(
      `UPDATE outbox SET status = 'dispatched', last_attempt_at = NULL
       WHERE task_id = $1 AND command->>'kind' = 'send'`,
      [taskId],
    );
    for (let i = 0; i < 15; i += 1) {
      await runSendPhase(pool, observingProvider);
      const { rows } = await pool.query(
        `SELECT status FROM outbox WHERE task_id = $1 AND command->>'kind' = 'send'`,
        [taskId],
      );
      if (rows[0]?.status === 'superseded') break;
    }
    expect(calls).toBe(1);
    expect(
      (
        await pool.query(
          `SELECT status FROM outbox WHERE task_id = $1 AND command->>'kind' = 'send'`,
          [taskId],
        )
      ).rows,
    ).toEqual([{ status: 'superseded' }]);
  });

  it('an expired unconsumed lease can be reclaimed and sent once', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleAndArm(pool, taskId, ownerId);

    await driveClaimUntilLeased(pool, taskId, 'worker-expiry-a');
    // Force lease expiry with a DB timestamp update (no sleep).
    await pool.query(
      "UPDATE task_leases SET lease_expires_at = now() - interval '1 minute' WHERE task_id = $1",
      [taskId],
    );
    await driveClaimUntilLeased(pool, taskId, 'worker-expiry-b');
    const { rows: leases } = await pool.query(
      'SELECT lease_owner FROM task_leases WHERE task_id = $1',
      [taskId],
    );
    expect(leases[0]?.lease_owner).toBe('worker-expiry-b');

    await driveSendUntilFired(pool, provider, taskId, ownerId);
    const { rows: firedEvents } = await pool.query(
      "SELECT count(*) AS n FROM task_events WHERE task_id = $1 AND type = 'fired'",
      [taskId],
    );
    expect(Number(firedEvents[0]?.n)).toBe(1);
    await runSendPhase(pool, provider);
    const { rows: notices } = await pool.query(
      'SELECT count(*) AS n FROM notifications WHERE task_id = $1',
      [taskId],
    );
    expect(Number(notices[0]?.n)).toBe(1);
  });

  it('past-window tasks miss without firing', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleAndArm(pool, taskId, ownerId);
    // Force the fire instant 20 minutes into the past (past the window).
    await pool.query("UPDATE tasks SET fire_at_utc = now() - interval '20 minutes' WHERE id = $1", [
      taskId,
    ]);
    await runMissedPhase(pool);
    const detail = await getTaskDetail({ pool }, ownerId, taskId);
    expect(detail.state).toBe('missed');
    await runSendPhase(pool, provider);
    const { rows: firedEvents } = await pool.query(
      "SELECT count(*) AS n FROM task_events WHERE task_id = $1 AND type = 'fired'",
      [taskId],
    );
    expect(Number(firedEvents[0]?.n)).toBe(0);
  });

  for (const state of ['saved', 'pending_schedule']) {
    it(`terminates a never-scheduled ${state} task after the window without invoking a provider`, async () => {
      const { taskId, ownerId } = await confirmTask(pool);
      await pool.query(
        "UPDATE tasks SET state = $2, fire_at_utc = now() - interval '20 minutes' WHERE id = $1",
        [taskId, state],
      );
      let calls = 0;
      const noSend: InAppProvider = async () => {
        calls += 1;
        throw new Error('past-window task must not invoke a provider');
      };
      for (let tick = 0; tick < 3; tick += 1) {
        await Promise.all([runSchedulePhase(pool), runSchedulePhase(pool)]);
        await runClaimPhase(pool, 'unscheduled-deadline');
        await runSendPhase(pool, noSend);
        await runMissedPhase(pool);
      }
      expect((await getTaskDetail({ pool }, ownerId, taskId)).state).toBe('missed');
      expect(
        (
          await pool.query('SELECT schedule_receipt, state_version FROM tasks WHERE id = $1', [
            taskId,
          ])
        ).rows,
      ).toEqual([{ schedule_receipt: null, state_version: 2 }]);
      expect(
        (
          await pool.query(
            'SELECT type FROM task_events WHERE task_id = $1 ORDER BY state_version',
            [taskId],
          )
        ).rows,
      ).toEqual([{ type: 'created' }, { type: 'missed' }]);
      expect(
        (
          await pool.query('SELECT status, provider_receipt_id FROM outbox WHERE task_id = $1', [
            taskId,
          ])
        ).rows,
      ).toEqual([{ status: 'failed_deadline', provider_receipt_id: null }]);
      expect(
        (await pool.query('SELECT id FROM notifications WHERE task_id = $1', [taskId])).rows,
      ).toEqual([]);
      expect(calls).toBe(0);
    });
  }

  it('recovers historical failed schedule commands without reopening or duplicating events', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await pool.query("UPDATE tasks SET fire_at_utc = now() - interval '20 minutes' WHERE id = $1", [
      taskId,
    ]);
    // Exact old-worker residue: command is terminal, task was never registered.
    await pool.query("UPDATE outbox SET status = 'failed_deadline' WHERE task_id = $1", [taskId]);
    for (let tick = 0; tick < 3; tick += 1) {
      await Promise.all([runMissedPhase(pool), runMissedPhase(pool)]);
    }
    expect((await getTaskDetail({ pool }, ownerId, taskId)).state).toBe('missed');
    expect(
      (
        await pool.query('SELECT type FROM task_events WHERE task_id = $1 ORDER BY state_version', [
          taskId,
        ])
      ).rows,
    ).toEqual([{ type: 'created' }, { type: 'missed' }]);
    expect(
      (
        await pool.query('SELECT status, provider_receipt_id FROM outbox WHERE task_id = $1', [
          taskId,
        ])
      ).rows,
    ).toEqual([{ status: 'failed_deadline', provider_receipt_id: null }]);
  });

  it('preserves a committed cancellation when an unscheduled task is already past its window', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await pool.query("UPDATE tasks SET fire_at_utc = now() - interval '20 minutes' WHERE id = $1", [
      taskId,
    ]);
    await requestCancel({ pool }, ownerId, taskId, { idempotency_key: randomUUID() });
    await Promise.all([runSchedulePhase(pool), runMissedPhase(pool)]);
    expect((await getTaskDetail({ pool }, ownerId, taskId)).state).toBe('cancel_pending');
    await runCancelPhase(pool);
    await Promise.all([runSchedulePhase(pool), runMissedPhase(pool)]);
    expect((await getTaskDetail({ pool }, ownerId, taskId)).state).toBe('cancelled');
    expect(
      (
        await pool.query('SELECT type FROM task_events WHERE task_id = $1 ORDER BY state_version', [
          taskId,
        ])
      ).rows,
    ).toEqual([{ type: 'created' }, { type: 'cancel_requested' }, { type: 'cancelled' }]);
  });

  it('rolls back unscheduled deadline state and queue when the missed event cannot commit', async () => {
    const { taskId } = await confirmTask(pool);
    await pool.query("UPDATE tasks SET fire_at_utc = now() - interval '20 minutes' WHERE id = $1", [
      taskId,
    ]);
    await pool.query(
      `CREATE FUNCTION fail_unscheduled_missed() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN IF NEW.task_id = '${taskId}'::uuid AND NEW.type = 'missed'
       THEN RAISE EXCEPTION 'injected missed event failure'; END IF; RETURN NEW; END $$;
       CREATE TRIGGER fail_unscheduled_missed BEFORE INSERT ON task_events
       FOR EACH ROW EXECUTE FUNCTION fail_unscheduled_missed()`,
    );
    try {
      await expect(runSchedulePhase(pool)).rejects.toMatchObject({ code: 'P0001' });
      expect(
        (
          await pool.query(
            'SELECT state, state_version, schedule_receipt FROM tasks WHERE id = $1',
            [taskId],
          )
        ).rows,
      ).toEqual([{ state: 'saved', state_version: 1, schedule_receipt: null }]);
      expect(
        (await pool.query('SELECT status FROM outbox WHERE task_id = $1', [taskId])).rows,
      ).toEqual([{ status: 'pending' }]);
      expect(
        (await pool.query('SELECT type FROM task_events WHERE task_id = $1', [taskId])).rows,
      ).toEqual([{ type: 'created' }]);
    } finally {
      await pool.query(
        'DROP TRIGGER fail_unscheduled_missed ON task_events; DROP FUNCTION fail_unscheduled_missed()',
      );
    }
    await runSchedulePhase(pool);
    expect((await pool.query('SELECT state FROM tasks WHERE id = $1', [taskId])).rows).toEqual([
      { state: 'missed' },
    ]);
  });
});
