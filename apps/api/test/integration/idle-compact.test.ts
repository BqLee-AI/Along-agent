import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  freezeR3ControlContext,
  readR3ControlContext,
} from '../../src/modules/conversations/r3-context.js';
import {
  lockIdleCompactRequest,
  saveIdleCompactRequest,
} from '../../src/modules/conversations/idle-compact.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const suite = databaseUrl ? describe : describe.skip;
suite('idle compact admission facts', () => {
  let db: IntegrationDatabase;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });
  async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }
  async function fixture() {
    const ownerId = randomUUID(),
      conversationId = randomUUID();
    await db.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      conversationId,
      ownerId,
    ]);
    return { ownerId, conversationId };
  }
  test('control snapshot is exact, immutable and owner-scoped without a user message', async () => {
    const { ownerId, conversationId } = await fixture();
    const message = randomUUID(),
      runId = randomUUID();
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'assistant','history')",
      [message, ownerId, conversationId],
    );
    const binding = { ownerId, conversationId, runId };
    const frozen = await tx(async (c) => {
      await c.query(
        "INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context) VALUES($1,$2,$3,'test','chat','running',10,10000,'harness',NULL,$4::jsonb)",
        [
          runId,
          ownerId,
          conversationId,
          JSON.stringify({
            execution_profile: 'compact-memory/1',
            execution_lifecycle: 'server-owned',
          }),
        ],
      );
      return freezeR3ControlContext(c, binding);
    });
    expect(frozen.input).toEqual({ type: 'compact_control' });
    expect(frozen.manifest.message_ids).toEqual([message]);
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','later')",
      [randomUUID(), ownerId, conversationId],
    );
    expect(await tx((c) => readR3ControlContext(c, binding))).toEqual(frozen);
    await expect(
      tx((c) => readR3ControlContext(c, { ...binding, ownerId: randomUUID() })),
    ).rejects.toThrow();
    await expect(
      db.pool.query('UPDATE r3_context_freezes SET context=context WHERE run_id=$1', [runId]),
    ).rejects.toThrow();
  });
  test('same key serializes and replays no_content; other conversations conflict and owners are isolated', async () => {
    const first = await fixture(),
      other = await fixture(),
      key = randomUUID();
    const a = await db.pool.connect(),
      b = await db.pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      expect(await lockIdleCompactRequest(a, first.ownerId, first.conversationId, key)).toBeNull();
      const racing = lockIdleCompactRequest(b, first.ownerId, first.conversationId, key);
      await saveIdleCompactRequest(a, first.ownerId, first.conversationId, key, null);
      await a.query('COMMIT');
      expect(await racing).toEqual({ status: 'no_content', runId: null });
      await b.query('COMMIT');
      await expect(
        tx((c) => lockIdleCompactRequest(c, first.ownerId, other.conversationId, key)),
      ).rejects.toThrow();
      expect(
        await tx((c) => lockIdleCompactRequest(c, other.ownerId, other.conversationId, key)),
      ).toBeNull();
    } finally {
      a.release();
      b.release();
    }
  });
  test('accepted receipt commits atomically with its frozen control Run', async () => {
    const { ownerId, conversationId } = await fixture(),
      key = randomUUID(),
      runId = randomUUID();
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','history')",
      [randomUUID(), ownerId, conversationId],
    );
    await tx(async (c) => {
      expect(await lockIdleCompactRequest(c, ownerId, conversationId, key)).toBeNull();
      await c.query(
        "INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context) VALUES($1,$2,$3,'test','chat','running',10,10000,'harness',NULL,$4::jsonb)",
        [
          runId,
          ownerId,
          conversationId,
          JSON.stringify({
            execution_profile: 'compact-memory/1',
            execution_lifecycle: 'server-owned',
          }),
        ],
      );
      await freezeR3ControlContext(c, { ownerId, conversationId, runId });
      expect(await saveIdleCompactRequest(c, ownerId, conversationId, key, runId)).toEqual({
        status: 'accepted',
        runId,
      });
    });
    expect(await tx((c) => lockIdleCompactRequest(c, ownerId, conversationId, key))).toEqual({
      status: 'accepted',
      runId,
    });
    await expect(
      db.pool.query('DELETE FROM idle_compact_requests WHERE owner_id=$1 AND idempotency_key=$2', [
        ownerId,
        key,
      ]),
    ).rejects.toThrow();
  });
  test('no_content cannot be recorded for uncovered history and rollback leaves no receipt', async () => {
    const { ownerId, conversationId } = await fixture(),
      key = randomUUID();
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','content')",
      [randomUUID(), ownerId, conversationId],
    );
    await expect(
      tx(async (c) => {
        await lockIdleCompactRequest(c, ownerId, conversationId, key);
        await saveIdleCompactRequest(c, ownerId, conversationId, key, null);
      }),
    ).rejects.toThrow();
    expect(await tx((c) => lockIdleCompactRequest(c, ownerId, conversationId, key))).toBeNull();
  });
});
