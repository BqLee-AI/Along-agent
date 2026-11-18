import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../src/platform/errors.js';
import { measureSdkContext } from '../../src/features/model-providers/public.js';
import { cancelConversationRun } from '../../src/agent/operations/run.js';
import { executeCompact } from '../../src/agent/operations/compact-execution.js';
import type { CompactModelTransport } from '../../src/agent/operations/compact-model.js';
import type { CompactBinding } from '../../src/features/conversations/compact/compact-eligibility.js';
import { conversationMemorySources } from '../../src/features/conversations/history/memory-sources.js';
import { freezeR3Context } from '../../src/features/conversations/compact/r3-context.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
} from './setup.js';

interface Fixture {
  binding: CompactBinding;
  first: string;
}

(databaseUrl ? describe : describe.skip)('compact runtime integration', () => {
  let db: IntegrationDatabase;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  async function fixture() {
    const ownerId = randomUUID(),
      conversationId = randomUUID(),
      runId = randomUUID();
    const attemptId = randomUUID(),
      pauseId = randomUUID(),
      first = randomUUID(),
      current = randomUUID();
    const provider = randomUUID(),
      version = randomUUID();
    const binding: CompactBinding = { ownerId, conversationId, runId, attemptId, pauseId };
    const client = await db.pool.connect();
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
        `INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES
        ($1,$3,$4,'user','The user prefers tea.','2020-01-01'),($2,$3,$4,'user','current','2020-01-02')`,
        [first, current, ownerId, conversationId],
      );
      await client.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context)
        VALUES($1,$2,$3,'test','chat','paused',10,10000,'harness',$4,$5::jsonb)`,
        [
          runId,
          ownerId,
          conversationId,
          current,
          JSON.stringify({
            execution_profile: 'compact-memory/1',
            execution_lifecycle: 'request-bound',
          }),
        ],
      );
      await freezeR3Context(client, { ownerId, conversationId, runId, userMessageId: current });
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
        `INSERT INTO model_providers(id,owner_id,name,current_version_id) VALUES($1,$2,'provider',$3)`,
        [provider, ownerId, version],
      );
      await client.query(
        `INSERT INTO model_provider_versions(id,owner_id,provider_id,base_url) VALUES($1,$2,$3,'https://example.test')`,
        [version, ownerId, provider],
      );
      await client.query(
        `INSERT INTO model_provider_run_bindings(run_id,owner_id,version_id,provider_id,provider_name,model_id) VALUES($1,$2,$3,$4,'provider','model')`,
        [runId, ownerId, version, provider],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { binding, first };
  }

  function args(
    f: Fixture,
    transport: CompactModelTransport,
  ): Parameters<typeof executeCompact>[0] {
    return {
      pool: db.pool,
      binding: f.binding,
      messageIds: [f.first],
      promptRevision: 'compact/1',
      policy: {
        revision: 'r2a/1' as const,
        completion_cap: 256,
        model_window_tokens: null,
        input_meter: 'unavailable' as const,
        meter_revision: 'unavailable/1' as const,
        reserve_tokens: 0,
        model_binding: { model: 'model', adapter_revision: 'test/1' },
      },
      budget: {
        iterationsRemaining: 3,
        continuationIterations: 1,
        tokensRemaining: 1000,
        continuationTokens: 200,
        maxOutputTokens: 100,
      },
      transport,
      signal: new AbortController().signal,
      // This controlled seam exercises orchestration, not native continuation measurement.
      validateContinuation: async () => {},
      guard: (client: PoolClient, messageIds: readonly string[]) =>
        conversationMemorySources.validate(client, {
          ownerId: f.binding.ownerId,
          conversationId: f.binding.conversationId,
          messageIds: [...messageIds],
          purpose: 'read',
        }),
    };
  }

  function model(
    f: Fixture,
    candidates: unknown,
    usage: number | null,
    beforeReply?: () => Promise<void>,
  ) {
    let calls = 0;
    const transport: CompactModelTransport = {
      measure: measureSdkContext,
      async *model() {
        calls++;
        await beforeReply?.();
        yield {
          type: 'complete',
          reply: {
            message: {
              content: JSON.stringify({
                text: 'Prefers tea.',
                coverage: [{ sequence: 0, id: f.first }],
                candidates,
              }),
              tool_calls: [],
            },
            usage: usage === null ? null : { total_tokens: usage },
          },
        };
      },
    };
    return { transport, calls: () => calls };
  }

  async function cancel(binding: CompactBinding) {
    return cancelConversationRun(
      { pool: db.pool, timeContext: loadTimeContext('fixture-v1') },
      binding.ownerId,
      binding.conversationId,
      binding.runId,
      randomUUID(),
      { idempotency_key: randomUUID() },
    );
  }

  test('publishes a sourced candidate and records actual usage once', async () => {
    const f = await fixture();
    const m = model(f, [{ content: 'Prefers tea.', messageIds: [f.first] }], 42);
    const result = await executeCompact(args(f, m.transport));
    expect(result).toMatchObject({ status: 'published', candidates: { saved: 1, failed: 0 } });
    if (result.status !== 'published') throw new Error('summary not published');
    const rows = await db.pool.query(
      `SELECT r.owner_id,r.conversation_id,r.message_ids,r.content,r.source_kind,r.summary_id
      FROM r3_memory_revisions r WHERE r.owner_id=$1`,
      [f.binding.ownerId],
    );
    expect(rows.rows).toEqual([
      {
        owner_id: f.binding.ownerId,
        conversation_id: f.binding.conversationId,
        message_ids: [f.first],
        content: 'Prefers tea.',
        source_kind: 'compact',
        summary_id: result.summaryId,
      },
    ]);
    const op = (
      await db.pool.query(
        `SELECT status,call_started,usage_recorded,usage_tokens::text,candidate_status,candidate_saved_count,candidate_failed_count
      FROM compact_operations WHERE pause_id=$1`,
        [f.binding.pauseId],
      )
    ).rows[0];
    expect(op).toEqual({
      status: 'published',
      call_started: true,
      usage_recorded: true,
      usage_tokens: '42',
      candidate_status: 'saved',
      candidate_saved_count: 1,
      candidate_failed_count: 0,
    });
    expect(m.calls()).toBe(1);
  });

  test('invalid candidate preserves summary, reports failure and records unknown usage', async () => {
    const f = await fixture();
    const m = model(f, [{ content: 'Invented', messageIds: [randomUUID()] }], null);
    const result = await executeCompact(args(f, m.transport));
    expect(result).toMatchObject({
      status: 'published',
      candidates: { saved: 0, failed: 1, code: 'COMPACT_INVALID_CANDIDATES' },
    });
    expect(
      (
        await db.pool.query('SELECT id FROM compact_summaries WHERE owner_id=$1', [
          f.binding.ownerId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (await db.pool.query('SELECT id FROM r3_memories WHERE owner_id=$1', [f.binding.ownerId]))
        .rowCount,
    ).toBe(0);
    const op = (
      await db.pool.query(
        `SELECT usage_recorded,usage_tokens::text,candidate_status,candidate_error_code FROM compact_operations WHERE pause_id=$1`,
        [f.binding.pauseId],
      )
    ).rows[0];
    expect(op).toEqual({
      usage_recorded: true,
      usage_tokens: null,
      candidate_status: 'failed',
      candidate_error_code: 'COMPACT_INVALID_CANDIDATES',
    });
    expect(m.calls()).toBe(1);
  });

  test('continuation capacity and budget failures retain usage without publishing', async () => {
    for (const [code, usage] of [
      ['HARNESS_CONTEXT_LIMIT', 31],
      ['BUDGET_EXCEEDED', null],
    ] as const) {
      const f = await fixture();
      const m = model(f, [{ content: 'Prefers tea.', messageIds: [f.first] }], usage);
      const input = args(f, m.transport);
      let validations = 0;
      input.validateContinuation = async (frozen, result) => {
        validations++;
        expect(frozen.coverageMessageIds).toEqual([f.first]);
        expect(result.text).toBe('Prefers tea.');
        expect(result.usage).toEqual(usage === null ? null : { total_tokens: usage });
        const accounting = (
          await db.pool.query(
            'SELECT usage_recorded,usage_tokens::text FROM compact_operations WHERE pause_id=$1',
            [f.binding.pauseId],
          )
        ).rows[0];
        expect(accounting).toEqual({
          usage_recorded: true,
          usage_tokens: usage === null ? null : String(usage),
        });
        throw new ApplicationError(409, code, 'continuation rejected by controlled validator');
      };
      expect(await executeCompact(input)).toEqual({ status: 'failed', code });
      expect(
        (
          await db.pool.query('SELECT id FROM compact_summaries WHERE owner_id=$1', [
            f.binding.ownerId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (await db.pool.query('SELECT id FROM r3_memories WHERE owner_id=$1', [f.binding.ownerId]))
          .rowCount,
      ).toBe(0);
      const operation = (
        await db.pool.query(
          'SELECT status,error_code,usage_recorded,usage_tokens::text FROM compact_operations WHERE pause_id=$1',
          [f.binding.pauseId],
        )
      ).rows[0];
      expect(operation).toEqual({
        status: 'failed',
        error_code: code,
        usage_recorded: true,
        usage_tokens: usage === null ? null : String(usage),
      });
      expect(validations).toBe(1);
      expect(m.calls()).toBe(1);
    }
  });

  test('cancellation committed during model I/O prevents late summary and memory writes but keeps usage', async () => {
    const f = await fixture();
    const m = model(f, [{ content: 'Prefers tea.', messageIds: [f.first] }], 37, async () => {
      await cancel(f.binding);
    });
    expect(await executeCompact(args(f, m.transport))).toMatchObject({
      status: 'failed',
      code: 'COMPACT_CANCELLED',
    });
    expect(
      (
        await db.pool.query('SELECT id FROM compact_summaries WHERE owner_id=$1', [
          f.binding.ownerId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await db.pool.query('SELECT id FROM r3_memories WHERE owner_id=$1', [f.binding.ownerId]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          'SELECT status,usage_recorded,usage_tokens::text FROM compact_operations WHERE pause_id=$1',
          [f.binding.pauseId],
        )
      ).rows[0],
    ).toEqual({ status: 'cancelled', usage_recorded: true, usage_tokens: '37' });
    expect(m.calls()).toBe(1);
  });

  test('cancellation after summary commit prevents the later candidate transaction', async () => {
    const f = await fixture();
    const m = model(f, [{ content: 'Prefers tea.', messageIds: [f.first] }], 29);
    const input = args(f, m.transport);
    const sourceGuard = input.guard;
    let guardCalls = 0;
    let cancelling: Promise<unknown> | undefined;
    // Wait for the queued cancellation to commit after the real summary COMMIT,
    // before the compact caller can start its separate candidate transaction.
    input.pool = new Proxy(db.pool, {
      get(target, property) {
        if (property === 'connect')
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, key) {
                if (key === 'query')
                  return async (...queryArgs: unknown[]) => {
                    const result = await Reflect.apply(connection.query, connection, queryArgs);
                    if (queryArgs[0] === 'COMMIT' && cancelling) await cancelling;
                    return result;
                  };
                const value = Reflect.get(connection, key, connection);
                return typeof value === 'function' ? value.bind(connection) : value;
              },
            }) as PoolClient;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    input.guard = async (client, ids) => {
      await sourceGuard(client, ids);
      // The seventh guard is markCompactPublished, inside the summary transaction.
      // Queue cancellation on its attempt lock before allowing that transaction to commit.
      if (++guardCalls === 7) {
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
          .pid;
        cancelling = cancel(f.binding);
        let blocked = false;
        for (let i = 0; i < 2000 && !blocked; i++) {
          const row = (
            await db.pool.query<{ blocked: boolean }>(
              'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked',
              [pid],
            )
          ).rows[0]!;
          blocked = row.blocked;
        }
        if (!blocked) throw new Error('cancellation did not queue on summary transaction');
      }
    };
    const result = await executeCompact(input);
    await cancelling;
    expect(result).toMatchObject({
      status: 'published',
      candidates: { saved: 0, failed: 1, code: 'COMPACT_CANCELLED' },
    });
    expect(
      (
        await db.pool.query('SELECT id FROM compact_summaries WHERE owner_id=$1', [
          f.binding.ownerId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (await db.pool.query('SELECT id FROM r3_memories WHERE owner_id=$1', [f.binding.ownerId]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await db.pool.query(
          'SELECT status,candidate_status,usage_tokens::text FROM compact_operations WHERE pause_id=$1',
          [f.binding.pauseId],
        )
      ).rows[0],
    ).toEqual({ status: 'published', candidate_status: 'cancelled', usage_tokens: '29' });
    expect(m.calls()).toBe(1);
  });
});
