import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ThreadEvent } from '@along/stream-protocol';
import { executeRun } from '../../src/agent/operations/execute.js';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { listRunEvents } from '../../src/features/conversations/run/repository.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
} from './setup.js';

const timeContext = loadTimeContext('fixture-v1');
const maybe = databaseUrl ? describe : describe.skip;

maybe('business Run terminal accounting after account deactivation', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });

  async function accept() {
    const ownerId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, auth_email, display_name, timezone_id)
       VALUES ($1, $2, 'tester', 'Asia/Shanghai')`,
      [ownerId, `tester-${ownerId}@along.test`],
    );
    await admitTestUser(pool, ownerId);
    const deps = { pool, timeContext };
    const started = await startConversationRun(
      deps,
      ownerId,
      randomUUID(),
      { raw_text: '提醒我喝水', confirmed_timezone: 'Asia/Shanghai' },
      null,
    );
    if (!started.context) throw new Error('expected accepted Run context');
    return { deps, ownerId, context: started.context };
  }

  async function statuses(runId: string, attemptId: string) {
    return (
      await pool.query(
        `SELECT r.status AS run_status, a.status AS attempt_status
       FROM agent_runs r JOIN run_attempts a ON a.run_id = r.id
       WHERE r.id = $1 AND a.id = $2`,
        [runId, attemptId],
      )
    ).rows[0];
  }

  for (const order of ['before-execution', 'after-started'] as const) {
    it(`records failure without disclosing further events when disabled ${order}`, async () => {
      const { deps, ownerId, context } = await accept();
      const events: ThreadEvent[] = [];
      let deactivation: Promise<unknown> | undefined;
      const gatedPool = new Proxy(pool, {
        get(target, property) {
          if (property === 'connect')
            return async () => {
              // The first event's transaction must release its authorization
              // lock before deactivation can commit. Gate the next transaction,
              // rather than waiting inside the writer that holds that lock.
              await deactivation;
              return target.connect();
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      if (order === 'before-execution')
        await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ownerId]);
      await executeRun({ ...deps, pool: gatedPool }, context, async (event) => {
        events.push(event);
        if (order === 'after-started' && event.type === 'thread.started')
          deactivation = pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [
            ownerId,
          ]);
        return true;
      });
      await deactivation;

      expect(events.map((event) => event.type)).toEqual(
        order === 'before-execution' ? [] : ['thread.started'],
      );
      expect(await statuses(context.runId, context.attemptId)).toEqual({
        run_status: 'failed',
        attempt_status: 'failed',
      });
      const stored = await listRunEvents(pool, ownerId, context.runId);
      expect(stored.map((event) => event.type)).toEqual(
        order === 'before-execution' ? ['thread.failed'] : ['thread.started', 'thread.failed'],
      );
      expect(stored.at(-1)?.payload).toMatchObject({
        conversation_id: context.conversationId,
        run_id: context.runId,
        error: { code: 'INTERNAL_ERROR' },
      });
    });
  }

  it('finishes an in-flight write before deactivation commits and suppresses later content', async () => {
    const { deps, ownerId, context } = await accept();
    const disabler = await pool.connect();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: ThreadEvent[] = [];
    let disabling: Promise<void> | undefined;
    let execution: Promise<void> | undefined;
    let disableCommitted = false;
    const gatedPool = new Proxy(pool, {
      get(target, property) {
        if (property === 'connect')
          return async () => {
            await disabling;
            return target.connect();
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    try {
      const pid = (await disabler.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
        .pid;
      await disabler.query('BEGIN');
      execution = executeRun({ ...deps, pool: gatedPool }, context, async (event) => {
        events.push(event);
        if (event.type === 'thread.started') {
          entered.resolve();
          await release.promise;
        }
        return true;
      });
      await Promise.race([
        entered.promise,
        execution.then(() => {
          throw new Error('Run ended before the first write');
        }),
      ]);
      disabling = (async () => {
        await disabler.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ownerId]);
        await disabler.query('COMMIT');
        disableCommitted = true;
      })();

      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const result = await pool.query<{ blocked: boolean }>(
          'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
          [pid],
        );
        if (result.rows[0]?.blocked) {
          blocked = true;
          break;
        }
        if (disableCommitted) break;
      }
      expect(blocked).toBe(true);
      expect(events.map((event) => event.type)).toEqual(['thread.started']);

      release.resolve();
      await disabling;
      await execution;
      expect(events.map((event) => event.type)).toEqual(['thread.started']);
      expect(await statuses(context.runId, context.attemptId)).toEqual({
        run_status: 'failed',
        attempt_status: 'failed',
      });
      expect(
        (await listRunEvents(pool, ownerId, context.runId)).map((event) => event.type),
      ).toEqual(['thread.started', 'thread.failed']);
    } finally {
      release.resolve();
      await disabling?.catch(() => {});
      await execution?.catch(() => {});
      await disabler.query('ROLLBACK');
      disabler.release();
    }
  });

  for (const target of ['thread.started', 'thread.failed'] as const) {
    it(`does not disclose ${target} after deactivation commits during delivery`, async () => {
      const { deps, ownerId, context } = await accept();
      const delivered: Array<{ type: ThreadEvent['type']; disabled: boolean }> = [];
      let disabled = false;
      let intercepted = false;

      // Decorate only checked-out connections; all queries and commits still run
      // against PostgreSQL. A successful eligibility result and the target
      // checkpoint identify the relevant transaction, not a query count.
      const guardedPool = new Proxy(pool, {
        get(targetPool, property) {
          if (property === 'connect')
            return async () => {
              const client = await targetPool.connect();
              let authorized = false;
              return new Proxy(client, {
                get(connection, key) {
                  if (key === 'query')
                    return async (text: string, values?: unknown[]) => {
                      if (text === 'BEGIN') authorized = false;
                      if (text === 'COMMIT' && authorized && !intercepted) {
                        const checkpoints = await listRunEvents(connection, ownerId, context.runId);
                        if (checkpoints.some((event) => event.type === target)) {
                          intercepted = true;
                          const result = await connection.query(text, values);
                          // A separate transaction must commit before the
                          // application receives this commit acknowledgement.
                          await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [
                            ownerId,
                          ]);
                          disabled = true;
                          return result;
                        }
                      }
                      const result = await connection.query(text, values);
                      if (
                        result.rows.some((row) => row.status === 'active' && row.admitted === true)
                      )
                        authorized = true;
                      return result;
                    };
                  const value = Reflect.get(connection, key);
                  return typeof value === 'function' ? value.bind(connection) : value;
                },
              });
            };
          const value = Reflect.get(targetPool, property);
          return typeof value === 'function' ? value.bind(targetPool) : value;
        },
      });

      await executeRun({ ...deps, pool: guardedPool }, context, async (event) => {
        if (target === 'thread.failed' && event.type === 'thread.started')
          throw new Error('writer failure');
        delivered.push({ type: event.type, disabled });
        return true;
      });

      expect(intercepted).toBe(true);
      expect(disabled).toBe(true);
      expect(delivered.filter((event) => event.disabled)).toEqual([]);
      expect(await statuses(context.runId, context.attemptId)).toEqual({
        run_status: 'failed',
        attempt_status: 'failed',
      });
      const stored = await listRunEvents(pool, ownerId, context.runId);
      expect(stored.at(-1)?.type).toBe('thread.failed');
      expect(stored.at(-1)?.payload).toMatchObject({
        conversation_id: context.conversationId,
        run_id: context.runId,
        error: { code: 'INTERNAL_ERROR' },
      });
    });
  }

  it('still delivers a durable failure to an active owner after an execution error', async () => {
    const { deps, ownerId, context } = await accept();
    const events: ThreadEvent[] = [];
    await executeRun(deps, context, async (event) => {
      if (event.type === 'thread.started') throw new Error('writer failure');
      events.push(event);
      return true;
    });
    expect(events.map((event) => event.type)).toEqual(['thread.failed']);
    expect((await listRunEvents(pool, ownerId, context.runId)).map((event) => event.type)).toEqual([
      'thread.started',
      'thread.failed',
    ]);
    expect(await statuses(context.runId, context.attemptId)).toEqual({
      run_status: 'failed',
      attempt_status: 'failed',
    });
  });

  it('preserves the normal active-owner completion path', async () => {
    const { deps, context } = await accept();
    const events: ThreadEvent[] = [];
    await executeRun(deps, context, async (event) => {
      events.push(event);
      return true;
    });
    expect(events.map((event) => event.type)).toEqual([
      'thread.started',
      'message.delta',
      'thread.completed',
    ]);
    expect(await statuses(context.runId, context.attemptId)).toEqual({
      run_status: 'done',
      attempt_status: 'done',
    });
  });

  it('does not account against an attempt belonging to another Run', async () => {
    const first = await accept();
    const second = await accept();
    await expect(
      executeRun(
        first.deps,
        {
          ...first.context,
          attemptId: second.context.attemptId,
        },
        async () => true,
      ),
    ).rejects.toBeDefined();
    expect(await statuses(first.context.runId, first.context.attemptId)).toEqual({
      run_status: 'running',
      attempt_status: 'running',
    });
    expect(await statuses(second.context.runId, second.context.attemptId)).toEqual({
      run_status: 'running',
      attempt_status: 'running',
    });
  });
});
