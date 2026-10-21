// Cancel route: state machine, idempotency, auth/CSRF, terminal guards.
// Drives requestCancel directly (HTTP envelope parity is asserted through
// the CSRF + uuid-shape cases below via handleTaskRoute in the route test).
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { confirmApproval } from '../../src/modules/approvals/confirm.js';
import { getApprovalDetail } from '../../src/modules/approvals/service.js';
import { getTaskDetail } from '../../src/modules/tasks/service.js';
import { requestCancel } from '../../src/modules/tasks/cancel.js';
import { runCancelPhase } from '../../src/modules/tasks/scheduler/cancel-phase.js';
import { runClaimPhase } from '../../src/modules/tasks/scheduler/claim.js';
import {
  completeCancelFromReceipt,
  revokeLocalTaskQueue,
} from '../../src/modules/tasks/scheduler/scheduler-repository.js';
import { withTransaction } from '../../src/db/transaction.js';
import { runSchedulePhase } from '../../src/modules/tasks/scheduler/schedule.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
  seedApproval,
} from './setup.js';

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

async function scheduleTask(pool: Pool, taskId: string, ownerId: string): Promise<void> {
  for (let i = 0; i < 15; i += 1) {
    await runSchedulePhase(pool);
    const detail = await getTaskDetail({ pool }, ownerId, taskId);
    if (detail.state === 'scheduled') return;
  }
  expect((await getTaskDetail({ pool }, ownerId, taskId)).state).toBe('scheduled');
}

async function finishCancel(pool: Pool, taskId: string, ownerId: string): Promise<void> {
  for (let i = 0; i < 15; i += 1) {
    await runCancelPhase(pool);
    const detail = await getTaskDetail({ pool }, ownerId, taskId);
    if (detail.state === 'cancelled') return;
  }
  expect((await getTaskDetail({ pool }, ownerId, taskId)).state).toBe('cancelled');
}

maybe('tasks cancel', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });

  it('commits cancel_pending without a receipt; replay does not invent one', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleTask(pool, taskId, ownerId);
    const body = { reason: 'wait', idempotency_key: randomUUID() };
    const first = await requestCancel({ pool }, ownerId, taskId, body);
    expect(first).toMatchObject({ task_id: taskId, state: 'cancel_pending', duplicate: false });
    expect(await requestCancel({ pool }, ownerId, taskId, body)).toMatchObject({
      state: 'cancel_pending',
      duplicate: true,
    });
    const { rows: commands } = await pool.query(
      `SELECT status, provider_receipt_id FROM outbox
       WHERE task_id = $1 AND command->>'kind' = 'cancel'`,
      [taskId],
    );
    expect(commands).toEqual([{ status: 'pending', provider_receipt_id: null }]);
    const { rows: events } = await pool.query(
      `SELECT type FROM task_events WHERE task_id = $1
       AND type IN ('cancel_requested', 'cancelled')`,
      [taskId],
    );
    expect(events).toEqual([{ type: 'cancel_requested' }]);
    await finishCancel(pool, taskId, ownerId);
  });

  it('fresh worker revokes PG queue and lease, persists one receipt and one cancelled event', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleTask(pool, taskId, ownerId);
    await pool.query("UPDATE tasks SET fire_at_utc = now() - interval '10 seconds' WHERE id = $1", [
      taskId,
    ]);
    for (let i = 0; i < 15; i += 1) {
      await runClaimPhase(pool, 'cancel-restart-worker');
      const { rows } = await pool.query('SELECT task_id FROM task_leases WHERE task_id = $1', [
        taskId,
      ]);
      if (rows[0]) break;
    }
    const { rows: claimed } = await pool.query(
      'SELECT task_id FROM task_leases WHERE task_id = $1',
      [taskId],
    );
    expect(claimed).toHaveLength(1);
    const body = { reason: 'done', idempotency_key: randomUUID() };
    expect((await requestCancel({ pool }, ownerId, taskId, body)).state).toBe('cancel_pending');
    // A second API command may coexist until the worker completes the fence.
    await requestCancel({ pool }, ownerId, taskId, { idempotency_key: randomUUID() });
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `import { runCancelPhase } from ${JSON.stringify(
          new URL('../../src/modules/tasks/scheduler/cancel-phase.ts', import.meta.url).href,
        )};
       import { createPool } from ${JSON.stringify(
         new URL('../../src/db/pool.ts', import.meta.url).href,
       )};
       const pool = createPool(process.env.DATABASE_URL);
       if (!pool) throw new Error('DATABASE_URL is required for the cancellation worker');
       try { for (let i = 0; i < 15; i += 1) await runCancelPhase(pool); }
       finally { await pool.end(); }`,
      ],
      {
        env: { ...process.env, DATABASE_URL: database.connectionString },
        stdout: 'ignore',
        stderr: 'inherit',
      },
    );
    expect(await child.exited).toBe(0);
    const freshPool = database.connect();
    try {
      expect((await getTaskDetail({ pool: freshPool }, ownerId, taskId)).state).toBe('cancelled');
      await runCancelPhase(freshPool);
      expect(await requestCancel({ pool: freshPool }, ownerId, taskId, body)).toMatchObject({
        state: 'cancelled',
        duplicate: true,
      });
      const { rows: commands } = await freshPool.query(
        `SELECT id, status, provider_receipt_id, expected_state_version FROM outbox
         WHERE task_id = $1 AND command->>'kind' = 'cancel'`,
        [taskId],
      );
      const completed = commands.filter((row) => row.status === 'dispatched');
      expect(completed).toHaveLength(1);
      expect(completed[0].provider_receipt_id).toBe(
        `pg-cancel:${completed[0].id}:${completed[0].expected_state_version}`,
      );
      expect(commands.filter((row) => row.status === 'superseded')).toHaveLength(1);
      expect(
        (await freshPool.query('SELECT 1 FROM task_leases WHERE task_id = $1', [taskId])).rows,
      ).toHaveLength(0);
      const { rows: events } = await freshPool.query(
        `SELECT type, evidence_ref FROM task_events WHERE task_id = $1 AND type = 'cancelled'`,
        [taskId],
      );
      expect(events).toEqual([
        { type: 'cancelled', evidence_ref: completed[0].provider_receipt_id },
      ]);
    } finally {
      await freshPool.end();
    }
  });

  it('cannot receipt an unfenced lease and keeps consuming beyond the send retry budget', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleTask(pool, taskId, ownerId);
    await pool.query(
      `INSERT INTO task_leases
         (task_id, owner_id, expected_state_version, lease_owner, lease_expires_at)
       SELECT id, owner_id, state_version + 1, 'unfenced-worker', now() + interval '1 hour'
       FROM tasks WHERE id = $1`,
      [taskId],
    );
    const body = { idempotency_key: randomUUID() };
    await requestCancel({ pool }, ownerId, taskId, body);
    await pool.query(
      `UPDATE outbox SET attempt_no = 100, last_attempt_at = NULL
       WHERE task_id = $1 AND command->>'kind' = 'cancel'`,
      [taskId],
    );
    for (let i = 0; i < 15; i += 1) {
      await runCancelPhase(pool);
      const { rows } = await pool.query(
        `SELECT attempt_no FROM outbox WHERE task_id = $1 AND command->>'kind' = 'cancel'`,
        [taskId],
      );
      if (rows[0].attempt_no > 100) break;
    }
    const { rows: pending } = await pool.query(
      `SELECT status, provider_receipt_id, attempt_no,
         last_attempt_at > now() AS rearmed FROM outbox
       WHERE task_id = $1 AND command->>'kind' = 'cancel'`,
      [taskId],
    );
    expect(pending).toEqual([
      {
        status: 'pending',
        provider_receipt_id: null,
        attempt_no: 101,
        rearmed: true,
      },
    ]);
    expect((await requestCancel({ pool }, ownerId, taskId, body)).state).toBe('cancel_pending');
    expect(
      (
        await pool.query("SELECT 1 FROM task_events WHERE task_id = $1 AND type = 'cancelled'", [
          taskId,
        ])
      ).rows,
    ).toHaveLength(0);
    // Once the actual old lease is fenced, the same command is consumable.
    await pool.query(
      'UPDATE task_leases SET expected_state_version = expected_state_version - 1 WHERE task_id = $1',
      [taskId],
    );
    await pool.query(
      `UPDATE outbox SET last_attempt_at = NULL
       WHERE task_id = $1 AND command->>'kind' = 'cancel'`,
      [taskId],
    );
    await finishCancel(pool, taskId, ownerId);
  });

  it('rejects mismatched cancel target, owner and both version fences without a receipt', async () => {
    for (const fault of ['target', 'owner', 'payload-version', 'row-version']) {
      const { taskId, ownerId } = await confirmTask(pool);
      const body = { idempotency_key: randomUUID() };
      await requestCancel({ pool }, ownerId, taskId, body);
      const { rows: commands } = await pool.query(
        `SELECT id, command, expected_state_version FROM outbox
         WHERE task_id = $1 AND command->>'kind' = 'cancel'`,
        [taskId],
      );
      const row = commands[0];
      const command = { ...row.command };
      let owner = ownerId;
      let version = row.expected_state_version;
      if (fault === 'target') command.task_id = randomUUID();
      if (fault === 'owner') owner = randomUUID();
      if (fault === 'payload-version') command.expected_state_version -= 1;
      if (fault === 'row-version') {
        version += 1;
        command.expected_state_version = version;
      }
      await pool.query(
        'UPDATE outbox SET command = $2, owner_id = $3, expected_state_version = $4 WHERE id = $1',
        [row.id, JSON.stringify(command), owner, version],
      );
      for (let i = 0; i < 15; i += 1) {
        await runCancelPhase(pool);
        const { rows } = await pool.query('SELECT status FROM outbox WHERE id = $1', [row.id]);
        if (rows[0].status === 'superseded') break;
      }
      expect(
        (await pool.query('SELECT status, provider_receipt_id FROM outbox WHERE id = $1', [row.id]))
          .rows,
      ).toEqual([{ status: 'superseded', provider_receipt_id: null }]);
      expect((await getTaskDetail({ pool }, ownerId, taskId)).state).toBe('cancel_pending');
      await requestCancel({ pool }, ownerId, taskId, { idempotency_key: randomUUID() });
      await finishCancel(pool, taskId, ownerId);
    }
  });

  it('rolls back queue revocation, receipt, terminal state and event together on failure', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleTask(pool, taskId, ownerId);
    await requestCancel({ pool }, ownerId, taskId, { idempotency_key: randomUUID() });
    // Old durable work/lease models a worker interrupted before revocation.
    await pool.query(
      `UPDATE outbox SET status = 'pending'
       WHERE task_id = $1 AND command->>'kind' = 'schedule'`,
      [taskId],
    );
    await pool.query(
      `INSERT INTO task_leases
         (task_id, owner_id, expected_state_version, lease_owner, lease_expires_at)
       SELECT id, owner_id, state_version - 1, 'rollback-worker', now() + interval '1 hour'
       FROM tasks WHERE id = $1`,
      [taskId],
    );
    await expect(
      withTransaction(pool, async (client) => {
        const { rows: tasks } = await client.query(
          'SELECT state_version FROM tasks WHERE id = $1 FOR UPDATE',
          [taskId],
        );
        const { rows: commands } = await client.query(
          `SELECT id FROM outbox WHERE task_id = $1 AND command->>'kind' = 'cancel' FOR UPDATE`,
          [taskId],
        );
        const fence = { ownerId, taskId, expectedVersion: tasks[0].state_version };
        expect(await revokeLocalTaskQueue(client, fence, commands[0].id)).toBe(true);
        expect(await completeCancelFromReceipt(client, fence)).toBe(true);
        throw new Error('cancel transaction interrupted');
      }),
    ).rejects.toThrow('cancel transaction interrupted');
    expect((await getTaskDetail({ pool }, ownerId, taskId)).state).toBe('cancel_pending');
    expect(
      (
        await pool.query(
          `SELECT provider_receipt_id FROM outbox WHERE task_id = $1 AND command->>'kind' = 'cancel'`,
          [taskId],
        )
      ).rows,
    ).toEqual([{ provider_receipt_id: null }]);
    expect(
      (
        await pool.query(
          `SELECT status FROM outbox WHERE task_id = $1 AND command->>'kind' = 'schedule'`,
          [taskId],
        )
      ).rows,
    ).toEqual([{ status: 'pending' }]);
    expect(
      (await pool.query('SELECT 1 FROM task_leases WHERE task_id = $1', [taskId])).rows,
    ).toHaveLength(1);
    expect(
      (
        await pool.query("SELECT 1 FROM task_events WHERE task_id = $1 AND type = 'cancelled'", [
          taskId,
        ])
      ).rows,
    ).toHaveLength(0);
    await finishCancel(pool, taskId, ownerId);
  });

  it('a fresh API connection finishes only a real persisted queue-revocation receipt', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleTask(pool, taskId, ownerId);
    const body = { idempotency_key: randomUUID() };
    await requestCancel({ pool }, ownerId, taskId, body);
    // Execute the production revoke step, not a receipt setter: this checks
    // and mutates the durable queue before storing its evidence.
    await withTransaction(pool, async (client) => {
      const { rows: tasks } = await client.query(
        'SELECT state_version FROM tasks WHERE id = $1 FOR UPDATE',
        [taskId],
      );
      const { rows: commands } = await client.query(
        `SELECT id FROM outbox WHERE task_id = $1 AND command->>'kind' = 'cancel' FOR UPDATE`,
        [taskId],
      );
      expect(
        await revokeLocalTaskQueue(
          client,
          { ownerId, taskId, expectedVersion: tasks[0].state_version },
          commands[0].id,
        ),
      ).toBe(true);
    });
    const freshPool = database.connect();
    try {
      expect(await requestCancel({ pool: freshPool }, ownerId, taskId, body)).toMatchObject({
        task_id: taskId,
        state: 'cancelled',
        duplicate: true,
      });
      await runCancelPhase(freshPool);
      expect(
        (
          await freshPool.query(
            "SELECT 1 FROM task_events WHERE task_id = $1 AND type = 'cancelled'",
            [taskId],
          )
        ).rows,
      ).toHaveLength(1);
    } finally {
      await freshPool.end();
    }
  });

  it('rejects invalid bodies and terminal states', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await expect(
      requestCancel({ pool }, ownerId, taskId, { idempotency_key: 'not-a-uuid' }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(requestCancel({ pool }, ownerId, taskId, {})).rejects.toMatchObject({
      httpStatus: 400,
    });

    // Fired tasks: 409 with current state.
    await pool.query("UPDATE tasks SET state = 'fired' WHERE id = $1", [taskId]);
    await expect(
      requestCancel({ pool }, ownerId, taskId, { idempotency_key: randomUUID() }),
    ).rejects.toMatchObject({ httpStatus: 409, errorCode: 'STATE_CONFLICT' });

    // Missed tasks: 409 with current state.
    await pool.query("UPDATE tasks SET state = 'missed' WHERE id = $1", [taskId]);
    await expect(
      requestCancel({ pool }, ownerId, taskId, { idempotency_key: randomUUID() }),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('forbids cross-owner cancel', async () => {
    const { taskId } = await confirmTask(pool);
    await expect(
      requestCancel({ pool }, randomUUID(), taskId, { idempotency_key: randomUUID() }),
    ).rejects.toMatchObject({ httpStatus: 403 });
  });
});
