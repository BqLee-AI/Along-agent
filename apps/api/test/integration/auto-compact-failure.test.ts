import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { readCompactContinuation } from '../../src/agent/runtime/compact-continuation.js';
import { freezeR3Context } from '../../src/features/conversations/compact/r3-context.js';
import type { CompactBinding } from '../../src/features/conversations/compact/compact-eligibility.js';
import { cancelConversationRun } from '../../src/agent/operations/run.js';
import { executeRuntimeCompact } from '../../src/agent/operations/compact.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import type { ConversationDeps, RunContext } from '../../src/agent/runtime/contracts.js';
import { RunOwnership } from '../../src/agent/runtime/run-ownership.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
} from './setup.js';

(databaseUrl ? describe : describe.skip)('automatic compact failure continuation', () => {
  let db: IntegrationDatabase;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });
  async function tx<T>(fn: (client: PoolClient) => Promise<T>) {
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
  async function fixture(
    purpose: 'manual_compact' | 'automatic_compact',
    outcome: 'failed' | 'published',
    code = 'COMPACT_INVALID_RESPONSE',
  ) {
    const ownerId = randomUUID(),
      conversationId = randomUUID(),
      runId = randomUUID(),
      attemptId = randomUUID();
    const pauseId = randomUUID(),
      messageId = randomUUID(),
      inputId = randomUUID(),
      freezeId = randomUUID();
    const summaryId = outcome === 'published' ? randomUUID() : null;
    const binding: CompactBinding = { ownerId, conversationId, runId, attemptId, pauseId };
    await tx(async (client) => {
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
        `INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES
        ($1,$3,$4,'user','source','2020-01-01'),($2,$3,$4,'user','current','2020-01-02')`,
        [messageId, inputId, ownerId, conversationId],
      );
      await client.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context)
        VALUES($1,$2,$3,'test','chat','paused',8,8000,'harness',$4,$5::jsonb)`,
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
      const r3 = await freezeR3Context(client, {
        ownerId,
        conversationId,
        runId,
        userMessageId: inputId,
      });
      const snapshot = {
        version: 4,
        original_manifest: r3.manifest,
        original_summary: null,
        context: r3,
        tool_refs: [],
        next_call_no: 1,
        usage: { iterations: 2, tokens: 100 },
        waiting: null,
        native_state: {
          protected_messages: [],
          history_index: 0,
          units: [],
          hard_denied: '',
          closing_goal: false,
          pending_model: null,
        },
      };
      await client.query(
        `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'done')`,
        [attemptId, ownerId, runId],
      );
      await client.query(
        `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,'runtime',$7,'runtime','paused',$8::jsonb)`,
        [
          pauseId,
          ownerId,
          conversationId,
          runId,
          attemptId,
          randomUUID(),
          purpose,
          JSON.stringify(snapshot),
        ],
      );
      await client.query(
        `INSERT INTO compact_freezes(id,owner_id,conversation_id,run_id,attempt_id,pause_id,previous_revision,model_id,prompt_revision)
        VALUES($1,$2,$3,$4,$5,$6,0,'fixture-model','fixture/1')`,
        [freezeId, ownerId, conversationId, runId, attemptId, pauseId],
      );
      if (summaryId) {
        await client.query(
          `INSERT INTO compact_summaries(id,freeze_id,owner_id,conversation_id,revision,summary_text)
          VALUES($1,$2,$3,$4,1,'summary')`,
          [summaryId, freezeId, ownerId, conversationId],
        );
        const hash = createHash('sha256')
          .update(JSON.stringify(['user', 'source']), 'utf8')
          .digest();
        await client.query(
          `INSERT INTO compact_summary_sources(summary_id,position,message_id,source_hash) VALUES($1,0,$2,$3)`,
          [summaryId, messageId, hash],
        );
      }
      await client.query(
        `INSERT INTO compact_operations(pause_id,owner_id,conversation_id,run_id,attempt_id,status,freeze_id,summary_id,error_code,
        call_started,usage_recorded,usage_tokens,candidate_status,candidate_error_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,true,17,$10,$11)`,
        [
          pauseId,
          ownerId,
          conversationId,
          runId,
          attemptId,
          outcome,
          freezeId,
          summaryId,
          outcome === 'failed' ? code : null,
          outcome === 'published' ? 'failed' : 'pending',
          outcome === 'published' ? 'COMPACT_INVALID_CANDIDATES' : null,
        ],
      );
    });
    const resume = () =>
      tx((client) =>
        readCompactContinuation(
          client,
          binding,
          inputId,
          { maxIterations: 8, maxTokens: 8000 },
          async () => {},
        ),
      );
    return { binding, inputId, summaryId, resume };
  }
  for (const code of ['COMPACT_INVALID_RESPONSE', 'HARNESS_UNAVAILABLE']) {
    it(`refuses automatic failed ${code} without manufacturing a successor`, async () => {
      const f = await fixture('automatic_compact', 'failed', code);
      await expect(f.resume()).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
      const row = (
        await db.pool.query(
          `SELECT o.status,o.error_code,o.usage_tokens::int AS usage_tokens,p.state,
        (SELECT count(*)::int FROM run_attempts WHERE run_id=o.run_id) AS attempts
        FROM compact_operations o JOIN harness_pauses p ON p.id=o.pause_id WHERE o.pause_id=$1`,
          [f.binding.pauseId],
        )
      ).rows[0];
      expect(row).toMatchObject({
        status: 'failed',
        error_code: code,
        usage_tokens: 17,
        state: 'paused',
        attempts: 1,
      });
    });
  }
  it('retains manual failure semantics and charges original snapshot usage', async () => {
    const f = await fixture('manual_compact', 'failed');
    const result = await f.resume();
    expect(result.snapshot.usage).toEqual({ iterations: 3, tokens: 117 });
    expect(result.context.summary).toBeNull();
    expect(result.context.input).toEqual({
      type: 'user',
      message_id: f.inputId,
      content: 'current',
    });
  });
  it('allows published automatic summary despite independently failed candidates', async () => {
    const f = await fixture('automatic_compact', 'published');
    const result = await f.resume();
    expect(result.snapshot.usage).toEqual({ iterations: 3, tokens: 117 });
    expect(result.context.summary).toMatchObject({ id: f.summaryId, text: 'summary' });
    expect(result.context.messages).toEqual([]);
  });

  for (const cancelled of [false, true]) {
    it(
      cancelled
        ? 'preserves cancellation committed during automatic model I/O'
        : 'terminates the paused Run with the actual automatic summary error',
      async () => {
        const f = await fixture('automatic_compact', 'failed');
        const owner = await RunOwnership.tryAcquire(db.pool, f.binding.runId);
        if (!owner) throw new Error('test Run ownership unavailable');
        const entered = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        let calls = 0;
        try {
          const provider = randomUUID(),
            version = randomUUID();
          await tx(async (client) => {
            await client.query(
              `UPDATE compact_operations SET status='pending',error_code=NULL,freeze_id=NULL,
            call_started=false,usage_recorded=false,usage_tokens=NULL WHERE pause_id=$1`,
              [f.binding.pauseId],
            );
            await client.query('UPDATE run_attempts SET lease_token=$2 WHERE id=$1', [
              f.binding.attemptId,
              owner.token,
            ]);
            await client.query(
              `INSERT INTO model_providers(id,owner_id,name,current_version_id) VALUES($1,$2,'provider',$3)`,
              [provider, f.binding.ownerId, version],
            );
            await client.query(
              `INSERT INTO model_provider_versions(id,owner_id,provider_id,base_url)
            VALUES($1,$2,$3,'https://example.test')`,
              [version, f.binding.ownerId, provider],
            );
            await client.query(
              `INSERT INTO model_provider_run_bindings(run_id,owner_id,version_id,provider_id,provider_name,model_id)
            VALUES($1,$2,$3,$4,'provider','fixture-model')`,
              [f.binding.runId, f.binding.ownerId, version, provider],
            );
          });
          const policy = createContextPolicy({ completionCap: 512, model: 'fixture-model' });
          const timeContext = loadTimeContext('fixture-v1');
          const deps: ConversationDeps = {
            pool: db.pool,
            timeContext,
            harness: {
              binaryPath: '/unused',
              maxIterations: 8,
              maxTokens: 8000,
              contextPolicy: policy,
            },
            modelTransport: async () => ({
              measure: async () => ({
                wire_bytes: 1000,
                http_bytes: 1000,
                output_ceiling: 512,
                input_meter: {
                  quality: 'unavailable',
                  input_tokens: null,
                  meter_revision: 'unavailable/1',
                },
                limit_reason: null,
              }),
              model: async function* () {
                calls++;
                entered.resolve();
                await release.promise;
                yield {
                  type: 'complete' as const,
                  reply: {
                    message: { content: 'invalid JSON', tool_calls: [] },
                    usage: { total_tokens: 17 },
                  },
                };
              },
            }),
          };
          const context: RunContext = {
            ...f.binding,
            ownership: owner,
            requestId: randomUUID(),
            inputText: 'current',
            userMessageId: f.inputId,
            confirmedTimezone: null,
            anchorReceivedAtUtc: '2020-01-02T00:00:00Z',
            receivedAtUtc: '2020-01-02T00:00:00Z',
            foldChoice: 'none',
            maxIterations: 8,
            maxTokens: 8000,
            timeContext,
            execution: 'harness',
            allowlist: [],
            executionProfile: 'compact-memory/1',
            contextPolicy: policy,
            autoCompactPolicy: {
              evidenceId: 'test',
              model: 'fixture-model',
              adapterRevision: 'openai-chat/v1',
              meterRevision: 'test-meter/1',
              windowTokens: 10000,
              triggerRatio: 0.6,
              compactInputTokens: 1000,
              continuationTokens: 512,
              continuationIterations: 1,
            },
          };
          const executing = executeRuntimeCompact(deps, context);
          await Promise.race([
            entered.promise,
            executing.then(() => {
              throw new Error('compact stopped before model I/O');
            }),
          ]);
          if (cancelled)
            await cancelConversationRun(
              deps,
              f.binding.ownerId,
              f.binding.conversationId,
              f.binding.runId,
              randomUUID(),
              { idempotency_key: randomUUID() },
            );
          release.resolve();
          expect(await executing).toBeNull();
          const row = (
            await db.pool.query(
              `SELECT r.status AS run_status,o.status AS operation_status,o.error_code,
          o.usage_tokens::int AS usage_tokens,p.state AS pause_state,
          (SELECT count(*)::int FROM run_attempts WHERE run_id=r.id) AS attempts
          FROM agent_runs r JOIN compact_operations o ON o.run_id=r.id JOIN harness_pauses p ON p.id=o.pause_id
          WHERE r.id=$1`,
              [f.binding.runId],
            )
          ).rows[0];
          expect(row).toMatchObject(
            cancelled
              ? {
                  run_status: 'cancelled',
                  operation_status: 'cancelled',
                  pause_state: 'invalidated',
                  attempts: 1,
                }
              : {
                  run_status: 'failed',
                  operation_status: 'failed',
                  error_code: 'COMPACT_INVALID_RESPONSE',
                  usage_tokens: 17,
                  pause_state: 'invalidated',
                  attempts: 1,
                },
          );
          const events = (
            await db.pool.query(
              `SELECT c.kind,c.payload->'payload'->'error'->>'code' AS code
          FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
          WHERE a.run_id=$1 AND c.kind IN ('thread.failed','thread.cancelled')`,
              [f.binding.runId],
            )
          ).rows;
          expect(events).toEqual(
            cancelled
              ? [{ kind: 'thread.cancelled', code: null }]
              : [{ kind: 'thread.failed', code: 'COMPACT_INVALID_RESPONSE' }],
          );
          expect(calls).toBe(1);
        } finally {
          release.resolve();
          await owner.close();
        }
      },
      30000,
    );
  }
});
