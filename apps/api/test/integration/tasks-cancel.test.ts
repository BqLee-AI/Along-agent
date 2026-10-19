// Cancel route: state machine, idempotency, auth/CSRF, terminal guards.
// Drives requestCancel directly (HTTP envelope parity is asserted through
// the CSRF + uuid-shape cases below via handleTaskRoute in the route test).
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { confirmApproval } from '../../src/modules/approvals/confirm.js';
import { getApprovalDetail } from '../../src/modules/approvals/service.js';
import { getTaskDetail } from '../../src/modules/tasks/service.js';
import { requestCancel } from '../../src/modules/tasks/cancel.js';
import { clearRegistry, recordCancelReceipt } from '../../src/modules/tasks/scheduler/registry.js';
import { runSchedulePhase } from '../../src/modules/tasks/scheduler/schedule.js';
import { databaseUrl, requirePool, seedApproval } from './setup.js';

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

maybe('tasks cancel', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = requirePool();
    clearRegistry();
  });
  afterAll(async () => {
    clearRegistry();
    await pool.end();
  });

  it('stays cancel_pending without a revoke receipt (never lies cancelled)', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await runSchedulePhase(pool);
    const first = await requestCancel(
      { pool },
      ownerId,
      taskId,
      { reason: 'wait', idempotency_key: randomUUID() },
      () => false,
    );
    expect(first).toMatchObject({ task_id: taskId, state: 'cancel_pending', duplicate: false });
    const detail = await getTaskDetail({ pool }, ownerId, taskId);
    expect(detail.state).toBe('cancel_pending');
    const { rows: events } = await pool.query(
      'SELECT type FROM task_events WHERE task_id = $1 ORDER BY recorded_at_utc ASC',
      [taskId],
    );
    expect(events.map((e) => e.type)).toContain('cancel_requested');
    expect(events.map((e) => e.type)).not.toContain('cancelled');
  });

  it('reaches cancelled with a revoke receipt and replays duplicate', async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await runSchedulePhase(pool);
    recordCancelReceipt(taskId);
    const done = await requestCancel(
      { pool },
      ownerId,
      taskId,
      { reason: 'done', idempotency_key: randomUUID() },
      () => true,
    );
    expect(done).toMatchObject({ task_id: taskId, state: 'cancelled', duplicate: false });
    const replay = await requestCancel({ pool }, ownerId, taskId, {
      reason: 'done',
      idempotency_key: randomUUID(),
    });
    expect(replay).toMatchObject({ task_id: taskId, state: 'cancelled', duplicate: true });
    const { rows: events } = await pool.query(
      'SELECT type FROM task_events WHERE task_id = $1 ORDER BY recorded_at_utc ASC',
      [taskId],
    );
    expect(events.map((e) => e.type)).toContain('cancelled');
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
