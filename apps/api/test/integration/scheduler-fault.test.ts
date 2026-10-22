// Deterministic PostgreSQL scheduler regressions: repeated terminal scans,
// cancel-before-fire, stale versions and expired leases. SQL time/queue
// fixtures exercise behavior; these tests are not process-kill evidence.
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { confirmApproval } from '../../src/modules/approvals/confirm.js';
import { getApprovalDetail } from '../../src/modules/approvals/service.js';
import { getTaskDetail } from '../../src/modules/tasks/service.js';
import { requestCancel } from '../../src/modules/tasks/cancel.js';
import { runSchedulePhase } from '../../src/modules/tasks/scheduler/schedule.js';
import { runSendPhase } from '../../src/modules/tasks/scheduler/send.js';
import { runMissedPhase } from '../../src/modules/tasks/scheduler/missed.js';
import { driveClaimUntilLeased, driveSendUntilFired } from './scheduler-drivers.js';
import { recordCancelBreach } from '../../src/modules/tasks/scheduler/scheduler-repository.js';
import { runCancelPhase } from '../../src/modules/tasks/scheduler/cancel-phase.js';
import { runClaimPhase } from '../../src/modules/tasks/scheduler/claim.js';
import { runAckPhase } from '../../src/modules/tasks/scheduler/ack.js';
import {
  createLocalInAppProvider,
  type InAppNotice,
  type InAppProvider,
} from '../../src/modules/notifications/service.js';
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
});
