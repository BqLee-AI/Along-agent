import { createFixtureConversation } from '../helpers/bot-conversation.js';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  beginCompactCall,
  failCompact,
  recordCompactUsage,
} from '../../src/features/conversations/compact/compact-operations.js';
import type { CompactBinding } from '../../src/features/conversations/compact/compact-eligibility.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
} from './setup.js';

(databaseUrl ? describe : describe.skip)('compact operation accounting', () => {
  let db: IntegrationDatabase;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function fixture() {
    const ownerId = randomUUID(),
      conversationId = randomUUID(),
      runId = randomUUID();
    const attemptId = randomUUID(),
      pauseId = randomUUID(),
      inputId = randomUUID(),
      freezeId = randomUUID();
    const binding: CompactBinding = { ownerId, conversationId, runId, attemptId, pauseId };
    await tx(async (client) => {
      await client.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
        ownerId,
        `${ownerId}@example.test`,
      ]);
      await admitTestUser(client, ownerId);
      await createFixtureConversation(client, ownerId, { id: conversationId });
      await client.query(
        `INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','input')`,
        [inputId, ownerId, conversationId],
      );
      await client.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context)
        VALUES($1,$2,$3,'test','chat','paused',10,10000,'harness',$4,$5::jsonb)`,
        [
          runId,
          ownerId,
          conversationId,
          inputId,
          JSON.stringify({
            execution_profile: 'compact-memory/1',
            execution_lifecycle: 'request-bound',
          }),
        ],
      );
      await client.query(
        `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'done')`,
        [attemptId, ownerId, runId],
      );
      await client.query(
        `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,'runtime','manual_compact','runtime','paused','{}')`,
        [pauseId, ownerId, conversationId, runId, attemptId, randomUUID()],
      );
      await client.query(
        `INSERT INTO compact_operations(pause_id,owner_id,conversation_id,run_id,attempt_id,status)
        VALUES($1,$2,$3,$4,$5,'pending')`,
        [pauseId, ownerId, conversationId, runId, attemptId],
      );
      await client.query(
        `INSERT INTO compact_freezes(id,owner_id,conversation_id,run_id,attempt_id,pause_id,previous_revision,model_id,prompt_revision)
        VALUES($1,$2,$3,$4,$5,$6,0,'model','test')`,
        [freezeId, ownerId, conversationId, runId, attemptId, pauseId],
      );
    });
    return { binding, freezeId };
  }
  const guard = async () => {};

  test('reserves once, preserves unknown usage, and records real failure', async () => {
    const { binding, freezeId } = await fixture();
    await expect(
      tx((client) =>
        beginCompactCall(client, binding, freezeId, async () => {
          throw new Error('revoked');
        }),
      ),
    ).rejects.toThrow('revoked');
    await tx((client) => beginCompactCall(client, binding, freezeId, guard));
    await expect(
      tx((client) => beginCompactCall(client, binding, freezeId, guard)),
    ).rejects.toThrow();
    await tx((client) => recordCompactUsage(client, binding, null));
    await tx((client) => recordCompactUsage(client, binding, null));
    await expect(tx((client) => recordCompactUsage(client, binding, 0))).rejects.toThrow();
    await tx((client) => failCompact(client, binding, 'HARNESS_UNAVAILABLE'));
    const row = (
      await db.pool.query(
        `SELECT status,call_started,usage_recorded,usage_tokens,error_code FROM compact_operations WHERE pause_id=$1`,
        [binding.pauseId],
      )
    ).rows[0];
    expect(row).toEqual({
      status: 'failed',
      call_started: true,
      usage_recorded: true,
      usage_tokens: null,
      error_code: 'HARNESS_UNAVAILABLE',
    });
  });

  test('records late measured usage after cancellation without reviving operation', async () => {
    const { binding, freezeId } = await fixture();
    await tx((client) => beginCompactCall(client, binding, freezeId, guard));
    await tx(async (client) => {
      await client.query('SELECT 1 FROM run_attempts WHERE id=$1 FOR UPDATE', [binding.attemptId]);
      await client.query('SELECT 1 FROM agent_runs WHERE id=$1 FOR UPDATE', [binding.runId]);
      await client.query(`UPDATE harness_pauses SET state='invalidated' WHERE id=$1`, [
        binding.pauseId,
      ]);
      await client.query(
        `UPDATE compact_operations SET status='cancelled',candidate_status='cancelled' WHERE pause_id=$1`,
        [binding.pauseId],
      );
      await client.query(`UPDATE agent_runs SET status='cancelled' WHERE id=$1`, [binding.runId]);
    });
    await tx((client) => recordCompactUsage(client, binding, 17));
    await expect(
      tx((client) => beginCompactCall(client, binding, freezeId, guard)),
    ).rejects.toThrow();
    const row = (
      await db.pool.query(
        `SELECT status,usage_recorded,usage_tokens,candidate_status FROM compact_operations WHERE pause_id=$1`,
        [binding.pauseId],
      )
    ).rows[0];
    expect(row).toEqual({
      status: 'cancelled',
      usage_recorded: true,
      usage_tokens: '17',
      candidate_status: 'cancelled',
    });
  });
});
