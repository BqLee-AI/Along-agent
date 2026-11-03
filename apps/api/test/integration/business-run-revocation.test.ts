import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ThreadEvent } from '@along/stream-protocol';
import { executeRun, startConversationRun } from '../../src/modules/conversations/service.js';
import { listRunEvents } from '../../src/modules/conversations/repository.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
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
      if (order === 'before-execution')
        await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ownerId]);
      await executeRun(deps, context, async (event) => {
        events.push(event);
        if (order === 'after-started' && event.type === 'thread.started')
          await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [ownerId]);
        return true;
      });

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
