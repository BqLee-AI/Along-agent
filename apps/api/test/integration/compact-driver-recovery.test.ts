import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { cancelConversationRun } from '../../src/agent/run/run-actions.js';
import { getCompactReceipt } from '../../src/agent/compact/runtime-compact.js';
import { createRunDriver } from '../../src/agent/execution/driver/driver.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
} from './setup.js';

(databaseUrl ? describe : describe.skip)('compact owner interruption recovery', () => {
  let database: IntegrationDatabase;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });

  async function fixture(published: boolean) {
    const ownerId = randomUUID(),
      conversationId = randomUUID(),
      runId = randomUUID();
    const attemptId = randomUUID(),
      pauseId = randomUUID(),
      messageId = randomUUID();
    const freezeId = randomUUID(),
      summaryId = published ? randomUUID() : null;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
        ownerId,
        `${ownerId}@example.test`,
      ]);
      await admitTestUser(client, ownerId);
      await client.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
        conversationId,
        ownerId,
      ]);
      await client.query(
        `INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','original source')`,
        [messageId, ownerId, conversationId],
      );
      await client.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context)
        VALUES($1,$2,$3,'test','chat','paused',8,8000,'harness',$4,$5::jsonb)`,
        [
          runId,
          ownerId,
          conversationId,
          messageId,
          JSON.stringify({
            execution_profile: 'compact-memory/1',
            execution_lifecycle: 'server-owned',
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
        `INSERT INTO compact_freezes(id,owner_id,conversation_id,run_id,attempt_id,pause_id,previous_revision,model_id,prompt_revision)
        VALUES($1,$2,$3,$4,$5,$6,0,'fixture-model','fixture/1')`,
        [freezeId, ownerId, conversationId, runId, attemptId, pauseId],
      );
      if (summaryId) {
        await client.query(
          `INSERT INTO compact_summaries(id,freeze_id,owner_id,conversation_id,revision,summary_text)
          VALUES($1,$2,$3,$4,1,'published summary')`,
          [summaryId, freezeId, ownerId, conversationId],
        );
        await client.query(
          `INSERT INTO compact_summary_sources(summary_id,position,message_id,source_hash)
          VALUES($1,0,$2,$3)`,
          [summaryId, messageId, Buffer.alloc(32, 1)],
        );
        await client.query(
          `INSERT INTO compact_heads(conversation_id,owner_id,summary_id,revision)
          VALUES($1,$2,$3,1)`,
          [conversationId, ownerId, summaryId],
        );
      }
      await client.query(
        `INSERT INTO compact_operations(pause_id,owner_id,conversation_id,run_id,attempt_id,status,freeze_id,summary_id,call_started,usage_recorded,usage_tokens)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)`,
        [
          pauseId,
          ownerId,
          conversationId,
          runId,
          attemptId,
          published ? 'published' : 'running',
          freezeId,
          summaryId,
          published,
          published ? 37 : null,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { ownerId, conversationId, runId, attemptId, pauseId, messageId, summaryId };
  }

  async function status(runId: string) {
    return (
      await database.pool.query<{ status: string }>('SELECT status FROM agent_runs WHERE id=$1', [
        runId,
      ])
    ).rows[0]?.status;
  }
  async function waitForFailure(runId: string) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const value = await status(runId);
      if (value === 'failed') return;
      if (value !== 'paused') throw new Error(`unexpected Run status ${value}`);
      await delay(50);
    }
    throw new Error('orphaned compact was not recovered');
  }
  async function effects(runId: string) {
    return (
      await database.pool.query<{
        attempts: number;
        invocations: number;
        failures: number;
        messages: number;
      }>(
        `SELECT (SELECT count(*)::int FROM run_attempts WHERE run_id=$1) AS attempts,
        (SELECT count(*)::int FROM tool_invocations WHERE run_id=$1) AS invocations,
        (SELECT count(*)::int FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
          WHERE a.run_id=$1 AND c.kind='thread.failed') AS failures,
        (SELECT count(*)::int FROM messages m JOIN agent_runs r ON r.conversation_id=m.conversation_id
          WHERE r.id=$1) AS messages`,
        [runId],
      )
    ).rows[0]!;
  }

  it('accounts unknown usage, preserves published summary, and never overrides cancellation or replays effects', async () => {
    const interrupted = await fixture(false);
    const published = await fixture(true);
    const cancelled = await fixture(true);
    const deps = { pool: database.pool, timeContext: loadTimeContext('fixture-v1') };
    await cancelConversationRun(
      deps,
      cancelled.ownerId,
      cancelled.conversationId,
      cancelled.runId,
      randomUUID(),
      { idempotency_key: randomUUID() },
    );
    const driver = createRunDriver(database.pool);
    try {
      await Promise.all([waitForFailure(interrupted.runId), waitForFailure(published.runId)]);
      const first = (
        await database.pool.query(
          `SELECT status,error_code,call_started,usage_recorded,usage_tokens
        FROM compact_operations WHERE pause_id=$1`,
          [interrupted.pauseId],
        )
      ).rows[0];
      expect(first).toMatchObject({
        status: 'failed',
        error_code: 'COMPACT_RUNTIME_INTERRUPTED',
        call_started: true,
        usage_recorded: true,
        usage_tokens: null,
      });
      const second = (
        await database.pool.query(
          `SELECT status,summary_id,candidate_status,candidate_error_code,usage_tokens::int AS usage_tokens
        FROM compact_operations WHERE pause_id=$1`,
          [published.pauseId],
        )
      ).rows[0];
      expect(second).toMatchObject({
        status: 'published',
        summary_id: published.summaryId,
        candidate_status: 'failed',
        candidate_error_code: 'COMPACT_RUNTIME_INTERRUPTED',
        usage_tokens: 37,
      });
      const summary = await database.pool.query(
        `SELECT s.summary_text,h.summary_id,cs.message_id
        FROM compact_summaries s JOIN compact_heads h ON h.summary_id=s.id
        JOIN compact_summary_sources cs ON cs.summary_id=s.id WHERE s.id=$1`,
        [published.summaryId],
      );
      expect(summary.rows).toEqual([
        {
          summary_text: 'published summary',
          summary_id: published.summaryId,
          message_id: published.messageId,
        },
      ]);
      const publishedReceipt = await getCompactReceipt(
        deps,
        published.ownerId,
        published.conversationId,
        published.runId,
        published.pauseId,
      );
      expect(publishedReceipt).toMatchObject({
        status: 'failed',
        error_code: 'COMPACT_RUNTIME_INTERRUPTED',
        candidate_status: 'failed',
      });
      expect(await status(cancelled.runId)).toBe('cancelled');
      const cancelledOperation = (
        await database.pool.query(
          `SELECT status,summary_id,candidate_status FROM compact_operations WHERE pause_id=$1`,
          [cancelled.pauseId],
        )
      ).rows[0];
      expect(cancelledOperation).toMatchObject({
        status: 'published',
        summary_id: cancelled.summaryId,
        candidate_status: 'cancelled',
      });
      const before = await Promise.all([
        effects(interrupted.runId),
        effects(published.runId),
        effects(cancelled.runId),
      ]);
      expect(before).toEqual([
        { attempts: 1, invocations: 0, failures: 1, messages: 1 },
        { attempts: 1, invocations: 0, failures: 1, messages: 1 },
        { attempts: 1, invocations: 0, failures: 0, messages: 1 },
      ]);
      // Let a second scanner pass run: recovery must not retry a model, create
      // another successor, or append another terminal result.
      await delay(2300);
      expect(
        await Promise.all([
          effects(interrupted.runId),
          effects(published.runId),
          effects(cancelled.runId),
        ]),
      ).toEqual(before);
      expect(
        (
          await database.pool.query('SELECT id FROM compact_summaries WHERE id=$1', [
            cancelled.summaryId,
          ])
        ).rowCount,
      ).toBe(1);
    } finally {
      await driver.shutdown();
    }
  }, 30000);

  it('recovers a lost successor without changing its published compact or replaying work', async () => {
    const f = await fixture(true);
    const successor = randomUUID();
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,2,'running')`,
        [successor, f.ownerId, f.runId],
      );
      await client.query(
        `INSERT INTO harness_pause_resumes(owner_id,idempotency_key,run_id,pause_id,attempt_id,source)
        VALUES($1,$2,$3,$4,$5,'runtime')`,
        [f.ownerId, randomUUID(), f.runId, f.pauseId, successor],
      );
      await client.query(`UPDATE harness_pauses SET state='consumed' WHERE id=$1`, [f.pauseId]);
      await client.query(
        `UPDATE compact_operations SET candidate_status='saved' WHERE pause_id=$1`,
        [f.pauseId],
      );
      await client.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [f.runId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const driver = createRunDriver(database.pool);
    try {
      const deadline = Date.now() + 12000;
      while ((await status(f.runId)) === 'running' && Date.now() < deadline) await delay(50);
      expect(await status(f.runId)).toBe('failed');
      expect(
        (await database.pool.query(`SELECT status FROM run_attempts WHERE id=$1`, [successor]))
          .rows[0]?.status,
      ).toBe('fenced_out');
      expect(
        (
          await database.pool.query(
            `SELECT c.payload->'payload'->'error'->>'code' AS code
        FROM run_checkpoints c WHERE c.attempt_id=$1 AND c.kind='thread.failed'`,
            [successor],
          )
        ).rows[0]?.code,
      ).toBe('HARNESS_UNAVAILABLE');
      expect(
        (
          await database.pool.query(
            `SELECT status,summary_id,candidate_status,usage_tokens::int AS usage_tokens
        FROM compact_operations WHERE pause_id=$1`,
            [f.pauseId],
          )
        ).rows[0],
      ).toMatchObject({
        status: 'published',
        summary_id: f.summaryId,
        candidate_status: 'saved',
        usage_tokens: 37,
      });
      expect(
        (
          await database.pool.query('SELECT summary_text FROM compact_summaries WHERE id=$1', [
            f.summaryId,
          ])
        ).rows[0]?.summary_text,
      ).toBe('published summary');
      const before = await effects(f.runId);
      expect(before).toEqual({ attempts: 2, invocations: 0, failures: 1, messages: 1 });
      await delay(2300);
      expect(await effects(f.runId)).toEqual(before);
    } finally {
      await driver.shutdown();
    }
  }, 30000);
});
