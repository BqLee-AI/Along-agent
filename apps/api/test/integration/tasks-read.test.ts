import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  getTaskDetail,
  getTaskEvents,
  listTasksForOwner,
} from '../../src/modules/tasks/service.js';
import { databaseUrl, requirePool } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;

async function seedTask(pool: Pool, ownerId: string): Promise<string> {
  const taskId = randomUUID();
  await pool.query(
    `INSERT INTO tasks (id, owner_id, fire_at_utc, wall_time, timezone_id, fold,
       resolved_utc_offset_seconds, tzdb_version, original_note)
     VALUES ($1,$2,'2026-10-17T01:20:00Z','2026-10-17 09:20','Asia/Shanghai',0,28800,'2024a','明天 9:20 喝水')`,
    [taskId, ownerId],
  );
  await pool.query(
    `INSERT INTO task_events (id, owner_id, task_id, state_version, type, evidence_ref)
     VALUES ($1,$2,$3,1,'created','req-seed')`,
    [randomUUID(), ownerId, taskId],
  );
  return taskId;
}

maybe('tasks read routes', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = requirePool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it('lists tasks ordered by fire_at with keyset pagination', async () => {
    const owner = randomUUID();
    await seedTask(pool, owner);
    await seedTask(pool, owner);
    const first = await listTasksForOwner({ pool }, owner, { limit: '1' });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.fire_at_local).toBe('2026-10-17 09:20');
    expect(first.next_cursor).not.toBeNull();
    const second = await listTasksForOwner({ pool }, owner, {
      limit: '1',
      cursor: first.next_cursor ?? undefined,
    });
    expect(second.items).toHaveLength(1);
  });

  it('detail exposes frozen fields without conversion', async () => {
    const owner = randomUUID();
    const taskId = await seedTask(pool, owner);
    const detail = await getTaskDetail({ pool }, owner, taskId);
    expect(detail.task_id).toBe(taskId);
    expect(detail.state).toBe('saved');
    expect(detail.state_version).toBe(1);
    expect(detail.fire_at_local).toBe('2026-10-17 09:20');
  });

  it('events project the append-only ledger ascending', async () => {
    const owner = randomUUID();
    const taskId = await seedTask(pool, owner);
    const { items } = await getTaskEvents({ pool }, owner, taskId, {});
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe('created');
    expect(items[0]?.evidence_ref).toBe('req-seed');
  });

  it('cross-owner reads are forbidden, missing rows are 404', async () => {
    const owner = randomUUID();
    const taskId = await seedTask(pool, owner);
    await expect(getTaskDetail({ pool }, randomUUID(), taskId)).rejects.toMatchObject({
      httpStatus: 403,
    });
    await expect(getTaskDetail({ pool }, owner, randomUUID())).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
});
