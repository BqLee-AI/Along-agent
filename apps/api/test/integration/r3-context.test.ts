import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  freezeCompact,
  publishCompact,
} from '../../src/features/conversations/compact/compact-store.js';
import type { CompactBinding } from '../../src/features/conversations/compact/compact-eligibility.js';
import {
  freezeR3Context,
  readR3Context,
  type R3ContextBinding,
} from '../../src/features/conversations/compact/r3-context.js';
import { appendEvent } from '../../src/features/conversations/run/run-state.js';
import { commitTerminal } from '../../src/agent/execution/result/commit.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
} from './setup.js';

const suite = databaseUrl ? describe : describe.skip;
suite('R3 immutable admission context', () => {
  let db: IntegrationDatabase;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });
  async function tx<T>(f: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await f(c);
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
      conversationId = randomUUID(),
      runId = randomUUID();
    const attemptId = randomUUID(),
      pauseId = randomUUID(),
      userMessageId = randomUUID();
    const first = randomUUID(),
      second = randomUUID(),
      provider = randomUUID(),
      version = randomUUID();
    await tx(async (c) => {
      await c.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
        ownerId,
        `${ownerId}@example.test`,
      ]);
      await admitTestUser(c, ownerId);
      await c.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
        conversationId,
        ownerId,
      ]);
      for (const [id, role, text, date] of [
        [first, 'user', 'first', '2020-01-01'],
        [second, 'assistant', 'second', '2020-01-02'],
        [userMessageId, 'user', 'original input', '2020-01-03'],
      ])
        await c.query(
          'INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [id, ownerId, conversationId, role, text, date],
        );
      await c.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context)
        VALUES($1,$2,$3,'test','chat','paused',10,10000,'harness',$4,$5::jsonb)`,
        [
          runId,
          ownerId,
          conversationId,
          userMessageId,
          JSON.stringify({
            execution_profile: 'compact-memory/1',
            execution_lifecycle: 'request-bound',
          }),
        ],
      );
      await freezeR3Context(c, { ownerId, conversationId, runId, userMessageId });
      await c.query(
        "INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'done')",
        [attemptId, ownerId, runId],
      );
      await c.query(
        "INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state,snapshot) VALUES($1,$2,$3,$4,$5,$6,'runtime','manual_compact','runtime','paused','{}')",
        [pauseId, ownerId, conversationId, runId, attemptId, randomUUID()],
      );
      await c.query(
        "INSERT INTO model_providers(id,owner_id,name,current_version_id) VALUES($1,$2,'provider',$3)",
        [provider, ownerId, version],
      );
      await c.query(
        "INSERT INTO model_provider_versions(id,owner_id,provider_id,base_url) VALUES($1,$2,$3,'https://example.test')",
        [version, ownerId, provider],
      );
      await c.query(
        "INSERT INTO model_provider_run_bindings(run_id,owner_id,version_id,provider_id,provider_name,model_id) VALUES($1,$2,$3,$4,'provider','model')",
        [runId, ownerId, version, provider],
      );
    });
    return {
      ownerId,
      conversationId,
      runId,
      userMessageId,
      first,
      second,
      compact: { ownerId, conversationId, runId, attemptId, pauseId } satisfies CompactBinding,
    };
  }
  function guardFor(binding: CompactBinding) {
    return async (c: PoolClient, ids: readonly string[]) => {
      const snapshot = (
        await c.query<{
          context: { manifest: { message_ids: string[] }; input: { message_id: string } };
        }>(
          'SELECT context FROM r3_context_freezes WHERE run_id=$1 AND owner_id=$2 AND conversation_id=$3',
          [binding.runId, binding.ownerId, binding.conversationId],
        )
      ).rows[0]?.context;
      if (
        !snapshot ||
        ids.some(
          (id) => id === snapshot.input.message_id || !snapshot.manifest.message_ids.includes(id),
        )
      )
        throw new Error('protected or non-admitted compact source');
    };
  }
  async function newRun(
    c: PoolClient,
    ownerId: string,
    conversationId: string,
    input = 'full input',
  ): Promise<R3ContextBinding> {
    const runId = randomUUID(),
      userMessageId = randomUUID();
    await c.query('SELECT id FROM conversations WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
      conversationId,
      ownerId,
    ]);
    await c.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user',$4)",
      [userMessageId, ownerId, conversationId, input],
    );
    await c.query(
      "INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context) VALUES($1,$2,$3,'test','chat','running',10,10000,'harness',$4,$5::jsonb)",
      [
        runId,
        ownerId,
        conversationId,
        userMessageId,
        JSON.stringify({
          execution_profile: 'compact-memory/1',
          execution_lifecycle: 'request-bound',
        }),
      ],
    );
    return { ownerId, conversationId, runId, userMessageId };
  }

  test('more than 64 messages are preserved in order, input is separate, and owner isolation is enforced', async () => {
    const f = await fixture();
    await tx(async (c) => {
      for (let i = 0; i < 80; i++)
        await c.query(
          "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'assistant',$4, '2021-01-01'::timestamptz + $5 * interval '1 second')",
          [randomUUID(), f.ownerId, f.conversationId, `message ${i}`, i],
        );
    });
    const { binding, context } = await tx(async (c) => {
      const binding = await newRun(c, f.ownerId, f.conversationId, 'complete input');
      return { binding, context: await freezeR3Context(c, binding) };
    });
    expect(context.messages).toHaveLength(83);
    expect(context.messages.slice(-80).map((m) => m.content)).toEqual(
      Array.from({ length: 80 }, (_, i) => `message ${i}`),
    );
    expect(context.input.content).toBe('complete input');
    expect(context.manifest.message_ids).toEqual(context.messages.map((m) => m.message_id));
    expect(await tx((c) => readR3Context(c, binding))).toEqual(context);
    await expect(
      tx((c) => readR3Context(c, { ...binding, ownerId: randomUUID() })),
    ).rejects.toThrow();
    await expect(
      tx((c) =>
        c.query('UPDATE r3_context_freezes SET context=$2 WHERE run_id=$1', [binding.runId, '{}']),
      ),
    ).rejects.toThrow();
  });

  test('summary predecessor closure is exact and late earlier messages remain uncovered', async () => {
    const f = await fixture();
    const guard = guardFor(f.compact);
    const one = await tx((c) =>
      freezeCompact(c, f.compact, { messageIds: [f.first], promptRevision: 'test' }, guard),
    );
    await tx((c) =>
      publishCompact(
        c,
        f.compact,
        { freezeId: one.freezeId, text: 'one', messageIds: [f.first] },
        guard,
      ),
    );
    const two = await tx((c) =>
      freezeCompact(c, f.compact, { messageIds: [f.second], promptRevision: 'test' }, guard),
    );
    const published = await tx((c) =>
      publishCompact(
        c,
        f.compact,
        { freezeId: two.freezeId, text: 'two', messageIds: [f.first, f.second] },
        guard,
      ),
    );
    const late = randomUUID();
    await tx(async (c) => {
      await c.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [f.conversationId]);
      await c.query(
        "INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at) VALUES($1,$2,$3,'user','late','2020-01-01 12:00:00+00')",
        [late, f.ownerId, f.conversationId],
      );
    });
    const { binding, context } = await tx(async (c) => {
      const binding = await newRun(c, f.ownerId, f.conversationId);
      return { binding, context: await freezeR3Context(c, binding) };
    });
    expect(context.summary).toEqual({
      id: published.summaryId,
      revision: '2',
      text: 'two',
      message_ids: [f.first, f.second],
    });
    expect(context.messages.map((m) => m.message_id)).toEqual([late, f.userMessageId]);
    expect(context.manifest.message_ids).toEqual([f.first, late, f.second, f.userMessageId]);
    const compactBinding: CompactBinding = {
      ownerId: f.ownerId,
      conversationId: f.conversationId,
      runId: binding.runId,
      attemptId: randomUUID(),
      pauseId: randomUUID(),
    };
    await tx(async (c) => {
      await c.query("UPDATE agent_runs SET status='paused' WHERE id=$1", [binding.runId]);
      await c.query(
        "INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'done')",
        [compactBinding.attemptId, f.ownerId, binding.runId],
      );
      await c.query(
        "INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state,snapshot) VALUES($1,$2,$3,$4,$5,$6,'runtime','manual_compact','runtime','paused','{}')",
        [
          compactBinding.pauseId,
          f.ownerId,
          f.conversationId,
          binding.runId,
          compactBinding.attemptId,
          randomUUID(),
        ],
      );
      await c.query(
        `INSERT INTO model_provider_run_bindings(run_id,owner_id,version_id,provider_id,provider_name,model_id)
        SELECT $1,owner_id,version_id,provider_id,provider_name,model_id FROM model_provider_run_bindings WHERE run_id=$2`,
        [binding.runId, f.runId],
      );
    });
    const newGuard = guardFor(compactBinding);
    const three = await tx((c) =>
      freezeCompact(c, compactBinding, { messageIds: [late], promptRevision: 'test' }, newGuard),
    );
    expect(three.coverageMessageIds).toEqual([f.first, late, f.second]);
    const next = await tx((c) =>
      publishCompact(
        c,
        compactBinding,
        { freezeId: three.freezeId, text: 'three', messageIds: three.coverageMessageIds },
        newGuard,
      ),
    );
    const reordered = await tx(async (c) =>
      freezeR3Context(c, await newRun(c, f.ownerId, f.conversationId)),
    );
    expect(reordered.summary).toMatchObject({
      id: next.summaryId,
      message_ids: [f.first, late, f.second],
    });
    expect(reordered.manifest.message_ids.slice(0, 3)).toEqual([f.first, late, f.second]);
  });

  test('admission serializes with publication and preserves its selected head', async () => {
    const f = await fixture();
    const guard = guardFor(f.compact);
    const compact = await tx((c) =>
      freezeCompact(c, f.compact, { messageIds: [f.first], promptRevision: 'test' }, guard),
    );
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      const binding = await newRun(c, f.ownerId, f.conversationId);
      const context = await freezeR3Context(c, binding);
      const reachedGuard = Promise.withResolvers<void>();
      const publication = tx((p) =>
        publishCompact(
          p,
          f.compact,
          { freezeId: compact.freezeId, text: 'published', messageIds: [f.first] },
          async (client, ids) => {
            await guard(client, ids);
            reachedGuard.resolve();
          },
        ),
      );
      await reachedGuard.promise;
      await c.query('COMMIT');
      const published = await publication;
      expect(context.summary).toBeNull();
      expect(await tx((p) => readR3Context(p, binding))).toEqual(context);
      const next = await tx(async (p) =>
        freezeR3Context(p, await newRun(p, f.ownerId, f.conversationId)),
      );
      expect(next.summary?.id).toBe(published.summaryId);
    } finally {
      c.release();
    }
  });

  test('assistant terminal output serializes with the frozen admission view', async () => {
    const f = await fixture();
    const context = { ...f.compact, requestId: 'terminal-test' };
    await tx((c) =>
      appendEvent(c, context, 'message.delta', {
        conversation_id: f.conversationId,
        run_id: f.runId,
        delta: 'late assistant output',
      }),
    );
    const admission = await db.pool.connect();
    try {
      await admission.query('BEGIN');
      const binding = await newRun(admission, f.ownerId, f.conversationId);
      const frozen = await freezeR3Context(admission, binding);
      await expect(
        tx(async (c) => {
          await c.query("SET LOCAL lock_timeout='100ms'");
          return commitTerminal(
            c,
            context,
            'done',
            {
              conversation_id: f.conversationId,
              run_id: f.runId,
              approval_id: null,
            },
            { preserveAttemptStatus: true },
          );
        }),
      ).rejects.toMatchObject({ code: '55P03' });
      expect(frozen.messages.some((message) => message.content === 'late assistant output')).toBe(
        false,
      );
      await admission.query('COMMIT');
      await tx((c) =>
        commitTerminal(
          c,
          context,
          'done',
          {
            conversation_id: f.conversationId,
            run_id: f.runId,
            approval_id: null,
          },
          { preserveAttemptStatus: true },
        ),
      );
      const later = await tx(async (c) =>
        freezeR3Context(c, await newRun(c, f.ownerId, f.conversationId)),
      );
      expect(later.messages.some((message) => message.content === 'late assistant output')).toBe(
        true,
      );
      expect(await tx((c) => readR3Context(c, binding))).toEqual(frozen);
    } finally {
      await admission.query('ROLLBACK');
      admission.release();
    }
  });

  test('oversized input and excessive counts fail with context limit and roll back admission', async () => {
    const f = await fixture();
    await expect(
      tx(async (c) =>
        freezeR3Context(c, await newRun(c, f.ownerId, f.conversationId, 'x'.repeat(1048577))),
      ),
    ).rejects.toMatchObject({ errorCode: 'HARNESS_CONTEXT_LIMIT' });
    await tx((c) =>
      c.query(
        "INSERT INTO messages(id,owner_id,conversation_id,role,content) SELECT gen_random_uuid(),$1,$2,'assistant','x' FROM generate_series(1,4096)",
        [f.ownerId, f.conversationId],
      ),
    );
    await expect(
      tx(async (c) => freezeR3Context(c, await newRun(c, f.ownerId, f.conversationId))),
    ).rejects.toMatchObject({ errorCode: 'HARNESS_CONTEXT_LIMIT' });
  });
});
