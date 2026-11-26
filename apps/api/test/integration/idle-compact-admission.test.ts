import { createFixtureConversation } from '../helpers/bot-conversation.js';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import type { ConversationDeps, RunContext } from '../../src/agent/execution/contracts.js';
import { RunOwnership } from '../../src/agent/execution/driver/ownership.js';
import { getCompactReceipt } from '../../src/agent/compact/runtime-compact.js';
import { startConversationRun } from '../../src/agent/run/admit-message.js';
import { startIdleCompact } from '../../src/agent/compact/start-idle-compact.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import { configureTestModel } from '../helpers/model-selection.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

(databaseUrl ? describe : describe.skip)('idle compact Run admission', () => {
  let db: IntegrationDatabase;
  const owners = new Set<RunOwnership>();
  const starts: RunContext[] = [];
  let deps: ConversationDeps;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
    deps = {
      pool: db.pool,
      modelTransport: async () => {
        throw new Error('admission must not call the model');
      },
      timeContext: loadTimeContext('fixture-v1'),
      harness: {
        binaryPath: '/unused',
        maxIterations: 8,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({ completionCap: 512, model: 'idle-test' }),
      },
      runDriver: {
        async acquire(runId) {
          const owner = await RunOwnership.tryAcquire(db.pool, runId);
          if (!owner) throw new Error('owner unavailable');
          owners.add(owner);
          return owner;
        },
        async release(owner) {
          owners.delete(owner);
          await owner.close();
        },
        start(_deps, context) {
          starts.push(context);
        },
      },
    };
  });
  afterAll(async () => {
    for (const owner of owners) await owner.close();
    await db?.close();
  });
  test('same key commits one real control Run with frozen history and stable pause', async () => {
    const actor = await seedAdmittedSession(db.pool),
      conversationId = randomUUID(),
      messageId = randomUUID(),
      key = randomUUID();
    await configureTestModel(db.pool, actor.userId, 'idle-test');
    await createFixtureConversation(db.pool, actor.userId, { id: conversationId });
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','history')",
      [messageId, actor.userId, conversationId],
    );
    const before = starts.length;
    const call = () => startIdleCompact(deps, actor.userId, conversationId, randomUUID(), key);
    const [first, replay] = await Promise.all([call(), call()]);
    expect(first).toEqual(replay);
    expect(first.status).toBe('accepted');
    if (first.status !== 'accepted') throw new Error('expected admitted control Run');
    expect(starts.length - before).toBe(1);
    const row = (
      await db.pool.query<{
        input_message_id: string | null;
        context: { input: unknown; manifest: { message_ids: string[] } };
        state: string;
        model_id: string;
        lease_token: string | null;
      }>(
        `SELECT r.input_message_id,f.context,p.state,b.model_id,a.lease_token FROM agent_runs r
       JOIN r3_context_freezes f ON f.run_id=r.id JOIN harness_pauses p ON p.run_id=r.id
       JOIN run_attempts a ON a.id=p.attempt_id JOIN model_provider_run_bindings b ON b.run_id=r.id
       WHERE r.id=$1 AND p.id=$2`,
        [first.runId, first.pauseId],
      )
    ).rows[0]!;
    expect(row.input_message_id).toBeNull();
    expect(row.context.input).toEqual({ type: 'compact_control' });
    expect(row.context.manifest.message_ids).toEqual([messageId]);
    expect(row.state).toBe('pending');
    expect(row.model_id).toBe('idle-test');
    expect(row.lease_token).not.toBeNull();
    expect(
      (
        await db.pool.query('SELECT id FROM messages WHERE owner_id=$1 AND conversation_id=$2', [
          actor.userId,
          conversationId,
        ])
      ).rowCount,
    ).toBe(1);
    await expect(
      startIdleCompact(deps, actor.userId, conversationId, randomUUID(), randomUUID()),
    ).rejects.toThrow();
    const foreign = await seedAdmittedSession(db.pool);
    await expect(
      startIdleCompact(deps, foreign.userId, conversationId, randomUUID(), key),
    ).rejects.toThrow();
  });
  test('ordinary and idle admissions serialize owner before conversation without a deadlock', async () => {
    const actor = await seedAdmittedSession(db.pool),
      conversationId = randomUUID();
    await configureTestModel(db.pool, actor.userId, 'idle-test');
    await createFixtureConversation(db.pool, actor.userId, { id: conversationId });
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','history')",
      [randomUUID(), actor.userId, conversationId],
    );
    const blocker = await db.pool.connect();
    const waitFor = async (predicate: string) => {
      for (let i = 0; i < 5000; i++) {
        const found = await db.pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
           AND wait_event_type='Lock' AND ${predicate}`,
        );
        if (found.rowCount) return;
      }
      throw new Error('admission did not reach expected lock');
    };
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [conversationId]);
      const ordinary = startConversationRun(
        deps,
        actor.userId,
        randomUUID(),
        {
          conversation_id: conversationId,
          execution: 'harness',
          raw_text: 'new input',
        },
        randomUUID(),
      );
      const ordinaryResult = ordinary.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await waitFor("query LIKE 'SELECT status FROM conversations WHERE id=%FOR UPDATE%'");
      const idle = startIdleCompact(deps, actor.userId, conversationId, randomUUID(), randomUUID());
      const idleResult = idle.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await waitFor("wait_event='advisory'");
      await blocker.query('COMMIT');
      expect(await ordinaryResult).toHaveProperty('value');
      expect(await idleResult).toHaveProperty('error');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });
  test('synchronous driver failure is a durable failed Run and never restarts on replay', async () => {
    const actor = await seedAdmittedSession(db.pool),
      conversationId = randomUUID(),
      key = randomUUID();
    await configureTestModel(db.pool, actor.userId, 'idle-test');
    await createFixtureConversation(db.pool, actor.userId, { id: conversationId });
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','history')",
      [randomUUID(), actor.userId, conversationId],
    );
    let attempts = 0;
    const failing: ConversationDeps = {
      ...deps,
      runDriver: {
        ...deps.runDriver!,
        start() {
          attempts++;
          throw new Error('driver stopped');
        },
      },
    };
    const first = await startIdleCompact(failing, actor.userId, conversationId, randomUUID(), key);
    if (first.status !== 'accepted') throw new Error('expected admitted control Run');
    expect(
      await getCompactReceipt(deps, actor.userId, conversationId, first.runId, first.pauseId),
    ).toMatchObject({ status: 'failed', error_code: 'HARNESS_UNAVAILABLE' });
    const state = (
      await db.pool.query<{ status: string; attempt_status: string }>(
        'SELECT r.status,a.status AS attempt_status FROM agent_runs r JOIN run_attempts a ON a.run_id=r.id WHERE r.id=$1',
        [first.runId],
      )
    ).rows[0];
    expect(state).toEqual({ status: 'failed', attempt_status: 'fenced_out' });
    expect(
      await startIdleCompact(failing, actor.userId, conversationId, randomUUID(), key),
    ).toEqual(first);
    expect(attempts).toBe(1);
  });
  test('empty conversation is a durable no_content without driver or model', async () => {
    const actor = await seedAdmittedSession(db.pool),
      conversationId = randomUUID(),
      key = randomUUID();
    await createFixtureConversation(db.pool, actor.userId, { id: conversationId });
    const before = starts.length;
    expect(await startIdleCompact(deps, actor.userId, conversationId, randomUUID(), key)).toEqual({
      status: 'no_content',
      runId: null,
    });
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','later')",
      [randomUUID(), actor.userId, conversationId],
    );
    expect(await startIdleCompact(deps, actor.userId, conversationId, randomUUID(), key)).toEqual({
      status: 'no_content',
      runId: null,
    });
    expect(starts.length).toBe(before);
    expect(
      (await db.pool.query('SELECT id FROM agent_runs WHERE conversation_id=$1', [conversationId]))
        .rowCount,
    ).toBe(0);
  });
});
