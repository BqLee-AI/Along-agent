import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sendKeyFor } from '@along/scheduler-core';
import { handleRequest } from '../../src/http/app.js';
import type { ActorResolver } from '../../src/http/auth.js';
import { TaskDetailSchema } from '../../src/modules/tasks/schemas.js';
import {
  createLocalInAppProvider,
  deliverInApp,
  getTaskNotifications,
  type InAppProvider,
} from '../../src/modules/notifications/service.js';
import {
  getTaskDetail,
  getTaskEvents,
  listTasksForOwner,
} from '../../src/modules/tasks/service.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

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
    expect(detail.notifications).toEqual([]);
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

  it('does not hide a notification query failure as an empty successful detail', async () => {
    const owner = randomUUID();
    const taskId = await seedTask(pool, owner);
    const faultPool = {
      async connect() {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === 'query') {
              return (sql: string, values: unknown[]) => {
                if (sql.includes('FROM notifications')) {
                  return Promise.reject(new Error('notification read unavailable'));
                }
                return target.query(sql, values);
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as PoolClient;
      },
    } as Pool;
    await expect(getTaskDetail({ pool: faultPool }, owner, taskId)).rejects.toThrow(
      'notification read unavailable',
    );
    // The notification dependency is not consulted before task authorization.
    await expect(getTaskDetail({ pool: faultPool }, randomUUID(), taskId)).rejects.toMatchObject({
      httpStatus: 403,
    });
    let status = 0;
    let payload = '';
    await handleRequest(
      { method: 'GET', url: `/api/v1/tasks/${taskId}`, headers: {} } as IncomingMessage,
      {
        writeHead(value: number) {
          status = value;
        },
        end(value: string) {
          payload = value;
        },
      } as unknown as ServerResponse,
      {
        pool: faultPool,
        resolveActor: async () => ({
          ownerId: owner,
          sessionId: null,
          displayName: 'test',
          timezoneId: null,
        }),
      },
    );
    expect(status).toBe(500);
    expect(JSON.parse(payload).data).toBeNull();
    expect(payload).not.toContain('notification read unavailable');
  });

  it('projects persisted notices with owner/task isolation and no read side effects', async () => {
    const owner = randomUUID();
    const taskId = await seedTask(pool, owner);
    const otherTask = await seedTask(pool, owner);
    const expected = [];
    for (const status of ['pending', 'sent', 'failed'] as const) {
      const id = randomUUID();
      const sentAt = status === 'sent' ? '2026-10-17T01:20:01.000Z' : null;
      const title = `原样标题 ${status}\n09:20`;
      const body = '原样正文：2026-10-17 09:20（Asia/Shanghai）\n  喝水 <不改写>';
      await pool.query(
        `INSERT INTO notifications (id, owner_id, task_id, title, body, idempotency_key,
           status, sent_at) VALUES ($1::uuid,$2,$3,$4,$5,$1::text,$6,$7)`,
        [id, owner, taskId, title, body, status, sentAt],
      );
      expected.push({ id, title, body, status, sent_at: sentAt });
    }
    // Both predicates matter even if a corrupt/mismatched owner row exists.
    await pool.query(
      `INSERT INTO notifications (id, owner_id, task_id, title, body, idempotency_key)
       VALUES ($1::uuid,$2,$3,'hidden','hidden',$1::text),
         ($4::uuid,$5,$6,'other task','other task',$4::text)`,
      [randomUUID(), randomUUID(), taskId, randomUUID(), owner, otherTask],
    );
    const snapshot = async () => {
      const { rows } = await pool.query(
        `SELECT
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t WHERE owner_id = $1) AS tasks,
          (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM notifications n
            WHERE task_id IN ($2,$3)) AS notices,
          (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM task_events e
            WHERE task_id IN ($2,$3)) AS events,
          (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM outbox o
            WHERE task_id IN ($2,$3)) AS outbox`,
        [owner, taskId, otherTask],
      );
      return rows;
    };
    const before = await snapshot();
    const first = await getTaskDetail({ pool }, owner, taskId);
    expect(TaskDetailSchema.parse(first)).toEqual(first);
    expect(first.notifications).toHaveLength(3);
    expect(first.notifications).toEqual(expect.arrayContaining(expected));
    expect(await getTaskDetail({ pool }, owner, taskId)).toEqual(first);
    expect(await snapshot()).toEqual(before);
    await pool.query(
      "UPDATE tasks SET fire_at_utc = fire_at_utc + interval '2 hours' WHERE id = $1",
      [taskId],
    );
    expect((await getTaskDetail({ pool }, owner, taskId)).notifications).toEqual(
      first.notifications,
    );
    const list = await listTasksForOwner({ pool }, owner, {});
    for (const item of list.items) expect(item).not.toHaveProperty('notifications');
    const client = await pool.connect();
    try {
      expect(await getTaskNotifications(client, randomUUID(), taskId)).toEqual([]);
      expect(await getTaskNotifications(client, owner, otherTask)).toHaveLength(1);
    } finally {
      client.release();
    }
  });

  it('shows a notice committed by the real local provider on the next detail read', async () => {
    const owner = randomUUID();
    const taskId = await seedTask(pool, owner);
    expect((await getTaskDetail({ pool }, owner, taskId)).notifications).toEqual([]);
    // This SQL fixture supplies a frozen, registered task to real intake.
    const { rows: frozen } = await pool.query<{ fire_at_utc: Date }>(
      `UPDATE tasks SET state = 'scheduled', state_version = state_version + 1, schedule_receipt = $2
       WHERE id = $1 RETURNING fire_at_utc`,
      [taskId, `sched:${taskId}`],
    );
    await deliverInApp(
      {
        ownerId: owner,
        taskId,
        idempotencyKey: sendKeyFor(taskId, frozen[0]!.fire_at_utc.toISOString()),
      },
      provider,
    );
    const detail = await getTaskDetail({ pool }, owner, taskId);
    expect(detail.notifications).toHaveLength(1);
    expect(detail.notifications[0]?.status).toBe('sent');
    expect(detail.notifications[0]?.sent_at).not.toBeNull();
    const { rows } = await pool.query(
      'SELECT id, title, body, status, sent_at FROM notifications WHERE task_id = $1',
      [taskId],
    );
    expect(detail.notifications[0]).toEqual({
      ...rows[0],
      sent_at: rows[0].sent_at.toISOString(),
    });
  });

  it('preserves detail contracts over HTTP and in-process for success and access failures', async () => {
    const owner = randomUUID();
    const taskId = await seedTask(pool, owner);
    const emptyTaskId = await seedTask(pool, owner);
    const noticeId = randomUUID();
    await pool.query(
      `INSERT INTO notifications (id, owner_id, task_id, title, body, idempotency_key,
         status, sent_at) VALUES ($1::uuid,$2,$3,'原样标题','冻结正文 09:20',$1::text,'failed',NULL)`,
      [noticeId, owner, taskId],
    );
    const resolveActor: ActorResolver = async (req) =>
      req.headers['x-test-owner']
        ? {
            ownerId: String(req.headers['x-test-owner']),
            sessionId: null,
            displayName: 'test',
            timezoneId: null,
          }
        : null;
    const deps = { pool, resolveActor, tzdbVersion: '2024a' };
    const server = createServer((req, res) => void handleRequest(req, res, deps));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const sample of [
        { id: taskId, actor: owner, status: 200 },
        { id: emptyTaskId, actor: owner, status: 200 },
        { id: taskId, actor: randomUUID(), status: 403 },
        { id: randomUUID(), actor: owner, status: 404 },
        { id: 'not-a-uuid', actor: owner, status: 404 },
        { id: taskId, actor: null, status: 401 },
      ]) {
        const path = `/api/v1/tasks/${sample.id}`;
        const headers: Record<string, string> = sample.actor
          ? { 'x-test-owner': sample.actor }
          : {};
        const response = await fetch(`${base}${path}`, { headers });
        const httpBody = (await response.json()) as {
          data: unknown;
          error: { code: string } | null;
        };
        let status = 0;
        let payload = '';
        const req = { method: 'GET', url: path, headers } as unknown as IncomingMessage;
        const res = {
          writeHead(value: number) {
            status = value;
          },
          end(value: string) {
            payload = value;
          },
        } as unknown as ServerResponse;
        await handleRequest(req, res, deps);
        expect(response.status).toBe(sample.status);
        expect(status).toBe(sample.status);
        const localBody = JSON.parse(payload);
        if (sample.status === 200) {
          const detail = TaskDetailSchema.parse(httpBody.data);
          expect(detail).toEqual(localBody.data);
          expect(detail.notifications).toEqual(
            sample.id === emptyTaskId
              ? []
              : [
                  {
                    id: noticeId,
                    title: '原样标题',
                    body: '冻结正文 09:20',
                    status: 'failed',
                    sent_at: null,
                  },
                ],
          );
        } else {
          expect(httpBody.data).toBeNull();
          expect(localBody.data).toBeNull();
          expect(httpBody.error?.code).toBe(localBody.error.code);
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
