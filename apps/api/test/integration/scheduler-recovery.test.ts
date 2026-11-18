// Deterministic PostgreSQL regressions for one-shot permits and durable intake.
// SQL changes below are isolated test fixtures, not process-kill or v0 evidence.
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { Pool } from 'pg';
import { sendKeyFor } from '@along/scheduler-core';
import { confirmApproval } from '../../src/features/approvals/reminder/confirm.js';
import { getApprovalDetail } from '../../src/features/approvals/reminder/service.js';
import { requestCancel } from '../../src/features/tasks/cancellation/cancel.js';
import { getTaskDetail } from '../../src/features/tasks/service.js';
import { runSchedulePhase } from '../../src/features/tasks/scheduler/schedule.js';
import { runClaimPhase } from '../../src/features/tasks/scheduler/claim.js';
import { runSendPhase } from '../../src/features/tasks/scheduler/send.js';
import { runAckPhase } from '../../src/features/tasks/scheduler/ack.js';
import { runMissedPhase } from '../../src/features/tasks/scheduler/missed.js';
import { startWorkerLoop } from '../../src/worker/loop.js';
import {
  createLocalInAppProvider,
  getReceivedInApp,
  type InAppNotice,
  type InAppProvider,
} from '../../src/features/notifications/service.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedApproval,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;

interface ArmedTask extends InAppNotice {
  fireAtUtc: string;
  expectedStateVersion: number;
}

maybe('scheduler one-shot recovery with independent PostgreSQL intake', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  let receivePool: Pool;
  let localProvider: InAppProvider;

  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
    // Same isolated schema/options, different pool: reception cannot borrow
    // the task-lock-holding transaction's connection.
    receivePool = new Pool({ ...pool.options, max: 1 });
    localProvider = createLocalInAppProvider(receivePool);
  });
  afterAll(async () => {
    try {
      await receivePool?.end();
    } finally {
      await database?.close();
    }
  });

  async function arm(): Promise<ArmedTask> {
    const seed = await seedApproval(pool);
    const { detail } = await getApprovalDetail({ pool }, seed.ownerId, seed.id);
    const confirmed = await confirmApproval({ pool }, seed.ownerId, seed.id, {
      presentation_hash: seed.presentationHash,
      seen_content: detail.echo_text,
      idempotency_key: randomUUID(),
    });
    await runSchedulePhase(pool);
    expect((await getTaskDetail({ pool }, seed.ownerId, confirmed.task_id)).state).toBe(
      'scheduled',
    );
    const { rows } = await pool.query<{ fire_at_utc: Date; state_version: number }>(
      `UPDATE tasks SET fire_at_utc = date_trunc('milliseconds', now() - interval '10 seconds')
       WHERE id = $1 RETURNING fire_at_utc, state_version`,
      [confirmed.task_id],
    );
    const fireAtUtc = rows[0]!.fire_at_utc.toISOString();
    await runClaimPhase(pool, `recovery-${randomUUID()}`);
    const task = {
      taskId: confirmed.task_id,
      ownerId: seed.ownerId,
      idempotencyKey: sendKeyFor(confirmed.task_id, fireAtUtc),
      fireAtUtc,
      expectedStateVersion: rows[0]!.state_version,
    };
    expect((await sendRow(task)).status).toBe('dispatched');
    return task;
  }

  async function sendRow(task: ArmedTask) {
    const { rows } = await pool.query<{
      status: string;
      ack_check_no: number;
      provider_receipt_id: string | null;
      last_attempt_at: Date | null;
    }>(
      `SELECT status, ack_check_no, provider_receipt_id, last_attempt_at FROM outbox
       WHERE task_id = $1 AND command->>'kind' = 'send'`,
      [task.taskId],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function counts(task: ArmedTask) {
    const { rows } = await pool.query<{ notices: number; fired: number; missed: number }>(
      `SELECT
         (SELECT count(*)::int FROM notifications WHERE task_id = $1) AS notices,
         (SELECT count(*)::int FROM task_events WHERE task_id = $1 AND type = 'fired') AS fired,
         (SELECT count(*)::int FROM task_events WHERE task_id = $1 AND type = 'missed') AS missed`,
      [task.taskId],
    );
    return rows[0]!;
  }

  async function recheckNow(task: ArmedTask): Promise<void> {
    await pool.query(
      `UPDATE outbox SET last_attempt_at = NULL
       WHERE task_id = $1 AND command->>'kind' = 'send'`,
      [task.taskId],
    );
    await runAckPhase(pool);
  }

  async function received(task: ArmedTask) {
    const client = await pool.connect();
    try {
      return await getReceivedInApp(client, task.ownerId, task.taskId, task.idempotencyKey);
    } finally {
      client.release();
    }
  }

  async function unknownFixture(task: ArmedTask, checkNo = 0): Promise<void> {
    await pool.query(
      `UPDATE outbox SET status = 'acked_unknown', ack_check_no = $2,
         last_attempt_at = NULL, provider_receipt_id = NULL
       WHERE task_id = $1 AND command->>'kind' = 'send'`,
      [task.taskId, checkNo],
    );
  }

  async function pastWindowFixture(task: ArmedTask): Promise<void> {
    const fireAtUtc = new Date(Date.now() - 16 * 60_000).toISOString();
    task.fireAtUtc = fireAtUtc;
    task.idempotencyKey = sendKeyFor(task.taskId, fireAtUtc);
    await pool.query('UPDATE tasks SET fire_at_utc = $2 WHERE id = $1', [task.taskId, fireAtUtc]);
    await pool.query(
      `UPDATE outbox SET idempotency_key = $2,
         command = jsonb_set(jsonb_set(command, '{fire_at_utc}', to_jsonb($3::text)),
           '{idempotency_key}', to_jsonb($2::text))
       WHERE task_id = $1 AND command->>'kind' = 'send'`,
      [task.taskId, task.idempotencyKey, fireAtUtc],
    );
  }

  it('does not reenter after a permitted call throws, or invent receipt/fired', async () => {
    const task = await arm();
    let calls = 0;
    const failing: InAppProvider = async () => {
      calls += 1;
      throw new Error('injected provider failure without reception');
    };
    await runSendPhase(pool, failing);
    expect(calls).toBe(1);
    expect((await sendRow(task)).status).toBe('acked_unknown');
    for (let i = 0; i < 5; i += 1) {
      await recheckNow(task);
      await runSendPhase(pool, failing);
    }
    expect(calls).toBe(1);
    expect((await getTaskDetail({ pool }, task.ownerId, task.taskId)).state).toBe('scheduled');
    expect(await received(task)).toBeNull();
    expect(await counts(task)).toEqual({ notices: 0, fired: 0, missed: 0 });

    const positive = await arm();
    let positiveCalls = 0;
    await runSendPhase(pool, async (notice) => {
      positiveCalls += 1;
      return localProvider(notice);
    });
    expect(positiveCalls).toBe(1);
    expect((await getTaskDetail({ pool }, positive.ownerId, positive.taskId)).state).toBe('fired');
    expect(await counts(positive)).toEqual({ notices: 1, fired: 1, missed: 0 });

    await pastWindowFixture(task);
    await runMissedPhase(pool);
    await runSendPhase(pool, failing);
    expect(calls).toBe(1);
    expect((await getTaskDetail({ pool }, task.ownerId, task.taskId)).state).toBe('missed');
    expect((await sendRow(task)).status).toBe('failed_deadline');
    expect(await counts(task)).toEqual({ notices: 0, fired: 0, missed: 1 });
  });

  it('retains independent intake through a real result-transaction rollback and ack finishes once', async () => {
    const task = await arm();
    let calls = 0;
    const observing: InAppProvider = async (notice) => {
      calls += 1;
      return localProvider(notice);
    };
    // Only this file's schema and this task are affected. Failure occurs after
    // real reception COMMIT, inside the worker's task/fired/outbox transaction.
    await pool.query(`CREATE FUNCTION recovery_reject_fired() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected worker result rollback'; END; $$`);
    await pool.query(`CREATE TRIGGER recovery_reject_fired BEFORE INSERT ON task_events
      FOR EACH ROW WHEN (NEW.type = 'fired' AND NEW.task_id = '${task.taskId}'::uuid)
      EXECUTE FUNCTION recovery_reject_fired()`);
    try {
      await expect(runSendPhase(pool, observing)).rejects.toThrow(
        'injected worker result rollback',
      );
      expect(calls).toBe(1);
      expect((await getTaskDetail({ pool }, task.ownerId, task.taskId)).state).toBe('scheduled');
      expect((await sendRow(task)).status).toBe('acked_unknown');
      expect(await counts(task)).toEqual({ notices: 1, fired: 0, missed: 0 });
      const receipt = await received(task);
      expect(receipt?.fireAtUtc).toBe(task.fireAtUtc);
      expect(receipt?.expectedStateVersion).toBe(task.expectedStateVersion);
      expect(receipt?.receiptId).toBe(`inapp:${receipt?.notificationId}`);

      // A completed round reports actual phase failure, not a timer heartbeat.
      await pool.query(
        "UPDATE outbox SET last_attempt_at = NULL WHERE task_id = $1 AND command->>'kind' = 'send'",
        [task.taskId],
      );
      const workerId = `rollback-${randomUUID()}`;
      const checkpoints: Array<{ workerId: string; success: boolean }> = [];
      const failures: Array<{ phase: string; message: string }> = [];
      const ticks = channel('along.scheduler.tick');
      const observeTick = (message: unknown) => {
        if (
          message &&
          typeof message === 'object' &&
          'workerId' in message &&
          message.workerId === workerId &&
          'success' in message &&
          typeof message.success === 'boolean'
        ) {
          checkpoints.push({ workerId: message.workerId, success: message.success });
        }
      };
      ticks.subscribe(observeTick);
      const worker = startWorkerLoop({
        pool,
        workerId,
        intervalMs: 60_000,
        onError: (phase, error) => {
          failures.push({ phase, message: error instanceof Error ? error.message : String(error) });
        },
      });
      try {
        await worker.tick();
        expect(failures).toEqual([{ phase: 'ack', message: 'injected worker result rollback' }]);
        expect(checkpoints).toEqual([{ workerId, success: false }]);
        expect(calls).toBe(1);
        expect(await counts(task)).toEqual({ notices: 1, fired: 0, missed: 0 });
      } finally {
        ticks.unsubscribe(observeTick);
        await worker.stop();
      }
    } finally {
      await pool.query('DROP TRIGGER recovery_reject_fired ON task_events');
      await pool.query('DROP FUNCTION recovery_reject_fired()');
    }
    const receipt = await received(task);
    await recheckNow(task);
    await runSendPhase(pool, observing);
    await recheckNow(task);
    expect(calls).toBe(1);
    expect((await getTaskDetail({ pool }, task.ownerId, task.taskId)).state).toBe('fired');
    expect((await sendRow(task)).provider_receipt_id).toBe(receipt!.receiptId);
    expect(await counts(task)).toEqual({ notices: 1, fired: 1, missed: 0 });
  });

  for (const mismatch of ['legacy', 'owner', 'fire', 'version', 'task', 'send-key'] as const) {
    it(`does not accept a receipt with ${mismatch} binding`, async () => {
      const task = await arm();
      // Start with a genuine committed receipt, then corrupt only the fixture.
      await localProvider(task);
      const original = await received(task);
      expect(original?.expectedStateVersion).toBe(task.expectedStateVersion);
      if (mismatch === 'legacy') {
        await pool.query(
          'UPDATE notifications SET fire_at_utc = NULL, expected_state_version = NULL WHERE id = $1',
          [original!.notificationId],
        );
      } else if (mismatch === 'owner') {
        await pool.query('UPDATE notifications SET owner_id = $2 WHERE id = $1', [
          original!.notificationId,
          randomUUID(),
        ]);
      } else if (mismatch === 'fire') {
        await pool.query(
          "UPDATE notifications SET fire_at_utc = fire_at_utc + interval '1 second' WHERE id = $1",
          [original!.notificationId],
        );
      } else if (mismatch === 'version') {
        await pool.query(
          'UPDATE notifications SET expected_state_version = expected_state_version + 1 WHERE id = $1',
          [original!.notificationId],
        );
      } else if (mismatch === 'task') {
        const other = await arm();
        await pool.query('UPDATE notifications SET task_id = $2 WHERE id = $1', [
          original!.notificationId,
          other.taskId,
        ]);
        // This unrelated send is not part of the binding regression.
        await pool.query(
          "UPDATE outbox SET status = 'superseded' WHERE task_id = $1 AND command->>'kind' = 'send'",
          [other.taskId],
        );
      } else {
        await pool.query('UPDATE notifications SET idempotency_key = $2 WHERE id = $1', [
          original!.notificationId,
          `${task.idempotencyKey}:wrong`,
        ]);
      }
      if (mismatch !== 'send-key') {
        await expect(localProvider(task)).rejects.toThrow(
          'inapp intake idempotency binding conflict',
        );
      }
      await unknownFixture(task);
      await runAckPhase(pool);
      expect((await getTaskDetail({ pool }, task.ownerId, task.taskId)).state).toBe('scheduled');
      expect((await sendRow(task)).status).toBe('acked_unknown');
      expect((await counts(task)).fired).toBe(0);
      const { rows } = await pool.query('SELECT id FROM notifications WHERE id = $1', [
        original!.notificationId,
      ]);
      expect(rows).toEqual([{ id: original!.notificationId }]);
    });
  }

  it('keeps check three unknown, rechecks every five minutes, then accepts actual late intake', async () => {
    const task = await arm();
    await unknownFixture(task, 3);
    let calls = 0;
    const observing: InAppProvider = async (notice) => {
      calls += 1;
      return localProvider(notice);
    };
    for (let i = 0; i < 2; i += 1) {
      const before = Date.now();
      await recheckNow(task);
      const row = await sendRow(task);
      expect(row.status).toBe('acked_unknown');
      expect(row.ack_check_no).toBe(3);
      expect(row.last_attempt_at!.getTime()).toBeGreaterThanOrEqual(before + 300_000);
      expect(row.last_attempt_at!.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
      await runSendPhase(pool, observing);
    }
    expect(calls).toBe(0);
    expect(await counts(task)).toEqual({ notices: 0, fired: 0, missed: 0 });
    // Represents a still-in-flight receive completing, not scheduler reentry.
    const delivery = await localProvider(task);
    await recheckNow(task);
    expect((await getTaskDetail({ pool }, task.ownerId, task.taskId)).state).toBe('fired');
    expect((await sendRow(task)).provider_receipt_id).toBe(delivery.providerReceiptId);
    expect(await counts(task)).toEqual({ notices: 1, fired: 1, missed: 0 });
    expect(calls).toBe(0);
  });

  it('reconciles a valid receipt before missed can discard overdue work', async () => {
    const task = await arm();
    await pastWindowFixture(task);
    await unknownFixture(task, 3);
    const delivery = await localProvider(task);
    // Deliberately do not run ack first: missed itself must honor intake.
    await runMissedPhase(pool);
    expect((await getTaskDetail({ pool }, task.ownerId, task.taskId)).state).toBe('fired');
    expect((await sendRow(task)).provider_receipt_id).toBe(delivery.providerReceiptId);
    expect(await counts(task)).toEqual({ notices: 1, fired: 1, missed: 0 });
  });

  it('makes zero provider calls after cancellation commits, with a real positive control', async () => {
    const cancelled = await arm();
    const positive = await arm();
    const calls = new Map<string, number>();
    const observing: InAppProvider = async (notice) => {
      calls.set(notice.taskId, (calls.get(notice.taskId) ?? 0) + 1);
      return localProvider(notice);
    };
    const result = await requestCancel({ pool }, cancelled.ownerId, cancelled.taskId, {
      reason: 'cancel before permitted invocation',
      idempotency_key: randomUUID(),
    });
    expect(result.state).toBe('cancel_pending');
    await runSendPhase(pool, observing);
    await runSendPhase(pool, observing);
    await runAckPhase(pool);
    expect(calls.get(cancelled.taskId) ?? 0).toBe(0);
    expect(calls.get(positive.taskId)).toBe(1);
    expect(await counts(cancelled)).toEqual({ notices: 0, fired: 0, missed: 0 });
    expect(await received(cancelled)).toBeNull();
    expect(await counts(positive)).toEqual({ notices: 1, fired: 1, missed: 0 });
  });

  it('drains a real active tick before stop closes its independent receive pool', async () => {
    const task = await arm();
    const workerId = `drain-${randomUUID()}`;
    const workerPool = new Pool({ ...pool.options, max: 1 });
    const blocker = await pool.connect();
    const providerCalls = channel('along.notifications.provider-call');
    const ticks = channel('along.scheduler.tick');
    const completed: Array<{ workerId: string; success: boolean }> = [];
    const errors: unknown[] = [];
    let providerEntered!: () => void;
    const entering = new Promise<void>((resolve) => {
      providerEntered = resolve;
    });
    const observeProvider = (message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        'taskId' in message &&
        message.taskId === task.taskId
      ) {
        providerEntered();
      }
    };
    const observeTick = (message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        'workerId' in message &&
        message.workerId === workerId &&
        'success' in message &&
        typeof message.success === 'boolean'
      ) {
        completed.push({ workerId: message.workerId, success: message.success });
      }
    };
    providerCalls.subscribe(observeProvider);
    ticks.subscribe(observeTick);
    const worker = startWorkerLoop({
      pool: workerPool,
      workerId,
      intervalMs: 60_000,
      onError: (_phase, error) => {
        errors.push(error);
      },
    });
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE notifications IN ACCESS EXCLUSIVE MODE');
      const ticking = worker.tick();
      await Promise.race([
        entering,
        ticking.then(() => {
          throw new Error('tick completed without entering the real provider');
        }),
      ]);
      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(completed).toEqual([]);
      await blocker.query('COMMIT');
      await ticking;
      await stopping;
      expect(errors).toEqual([]);
      expect(completed).toEqual([{ workerId, success: true }]);
      expect((await getTaskDetail({ pool }, task.ownerId, task.taskId)).state).toBe('fired');
      expect(await counts(task)).toEqual({ notices: 1, fired: 1, missed: 0 });
      // Stop owns only its receive pool, not the injected scheduler pool.
      const { rows } = await workerPool.query('SELECT current_schema() AS schema');
      expect(rows[0]!.schema).toBe(
        (await pool.query('SELECT current_schema() AS schema')).rows[0]!.schema,
      );
      await worker.tick();
      expect(completed).toHaveLength(1);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      providerCalls.unsubscribe(observeProvider);
      ticks.unsubscribe(observeTick);
      await worker.stop();
      await workerPool.end();
    }
  });
});
