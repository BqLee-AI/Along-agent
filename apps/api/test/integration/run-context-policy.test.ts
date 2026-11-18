import { admitTestUser } from './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../../src/db/transaction.js';
import {
  createContextPolicy,
  digestContextPolicy,
  ensureRunContextPolicy,
  readRunContextPolicy,
} from '../../src/features/conversations/public.js';
import { readHarnessMessages } from '../../src/features/conversations/run/repository.js';
import { getRunView } from '../../src/agent/operations/run.js';
import type { ConversationDeps } from '../../src/agent/runtime/contracts.js';
import type { HarnessServices } from '../../src/agent/runtime/contracts.js';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { measureSdkContext } from '../../src/features/model-providers/public.js';
import {
  addModel,
  createProvider,
  setDefault,
  setModelContextWindow,
  updateProvider,
} from '../../src/features/model-providers/configuration/service.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';
import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';

const maybe = databaseUrl ? describe : describe.skip;
const policy = createContextPolicy({ completionCap: 512, model: 'context-fixture' });
function dependencies(pool: Pool, contextPolicy = policy): ConversationDeps {
  return controlledModelDeps({
    pool,
    timeContext: loadTimeContext('fixture-v1'),
    harness: {
      binaryPath: 'unused-by-admission',
      maxIterations: 8,
      maxTokens: 8000,
      contextPolicy,
      model: async function* () {
        yield {
          type: 'complete' as const,
          reply: { message: { content: 'unused', tool_calls: [] }, usage: null },
        };
      },
    } satisfies HarnessServices,
  });
}

maybe('harness frozen admission context', () => {
  let database: IntegrationDatabase;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });

  async function legacy(execution = 'harness') {
    const pool = database.pool;
    const ownerId = randomUUID(),
      conversationId = randomUUID(),
      runId = randomUUID(),
      userMessageId = randomUUID(),
      attemptId = randomUUID();
    await pool.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
      ownerId,
      `${ownerId}@context.test`,
    ]);
    await admitTestUser(pool, ownerId);
    await pool.query(
      `INSERT INTO conversations(id,owner_id,anchor_received_at_utc) VALUES($1,$2,now())`,
      [conversationId, ownerId],
    );
    await pool.query(
      `INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','legacy full input')`,
      [userMessageId, ownerId, conversationId],
    );
    await pool.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,frozen_context,tools_allowlist)
      VALUES($1,$2,$3,'context/test','chat','running',8,8000,$4,$5,'{}','[\"list_tasks\"]')`,
      [runId, ownerId, conversationId, execution, userMessageId],
    );
    await pool.query(
      `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'running')`,
      [attemptId, ownerId, runId],
    );
    return { ownerId, conversationId, runId, userMessageId, attemptId };
  }

  it('freezes the selected model window and falls back to the global window when unset', async () => {
    const pool = database.pool;
    const ownerId = randomUUID();
    await pool.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
      ownerId,
      `${ownerId}@context.test`,
    ]);
    await admitTestUser(pool, ownerId);
    const provider = await createProvider(pool, ownerId, 'Window fixture');
    await updateProvider(pool, ownerId, provider.id, {
      base_url: 'https://controlled-fixture.invalid/v1',
    });
    await addModel(pool, ownerId, provider.id, 'bounded', 150);
    await addModel(pool, ownerId, provider.id, 'unset');
    await setDefault(pool, ownerId, { provider_id: provider.id, model_id: 'bounded' });
    const globalPolicy = createContextPolicy({
      completionCap: 100,
      model: 'deployment-model',
      modelWindowTokens: 300,
      reserveTokens: 10,
      inputMeter: 'verified',
      meterRevision: 'fixture/1',
    });
    const deps = dependencies(pool, globalPolicy);
    const start = (model_id: string) =>
      startConversationRun(
        deps,
        ownerId,
        randomUUID(),
        {
          execution: 'harness',
          raw_text: 'window',
          model_selection: { provider_id: provider.id, model_id },
        },
        randomUUID(),
      );
    const bounded = await start('bounded');
    const unset = await start('unset');
    expect(bounded.context?.maxTokens).toBe(8000);
    expect(bounded.context?.contextPolicy?.model_window_tokens).toBe(150);
    expect(unset.context?.contextPolicy?.model_window_tokens).toBe(300);
    await setModelContextWindow(pool, ownerId, provider.id, 'bounded', 200);
    const changed = await start('bounded');
    await setModelContextWindow(pool, ownerId, provider.id, 'bounded', null);
    const cleared = await start('bounded');
    expect(cleared.context?.contextPolicy?.model_window_tokens).toBe(300);
    expect(changed.context?.contextPolicy?.model_window_tokens).toBe(200);
    const frozen = await readRunContextPolicy(pool, ownerId, bounded.runId);
    expect(frozen).toEqual(bounded.context!.contextPolicy!);
    const meter = () => ({
      quality: 'verified' as const,
      input_tokens: 100,
      meter_revision: 'fixture/1',
    });
    const request = {
      protocol: 'harness/v6' as const,
      type: 'measure_context' as const,
      request_ref: 'window',
      messages: [{ role: 'user' as const, content: 'window' }],
      remaining_tokens: 8000,
      max_output_tokens: 100,
    };
    expect(await measureSdkContext(request, [], frozen!, meter)).toMatchObject({
      output_ceiling: 40,
    });
    expect(
      await measureSdkContext(request, [], unset.context!.contextPolicy!, meter),
    ).toMatchObject({
      output_ceiling: 100,
    });
  });

  it('freezes the newest 63 visible predecessors and the complete accepted input', async () => {
    const pool = database.pool;
    const ownerId = randomUUID(),
      conversationId = randomUUID();
    await pool.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
      ownerId,
      `${ownerId}@context.test`,
    ]);
    await admitTestUser(pool, ownerId);
    await configureTestModel(pool, ownerId, 'context-fixture');
    await pool.query(
      `INSERT INTO conversations(id,owner_id,anchor_received_at_utc,confirmed_timezone_id)
      VALUES($1,$2,'2026-10-01T00:00:00Z','Asia/Shanghai')`,
      [conversationId, ownerId],
    );
    const predecessors: string[] = [];
    for (let i = 0; i < 70; i++) {
      const id = randomUUID();
      predecessors.push(id);
      await pool.query(
        `INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at)
        VALUES($1,$2,$3,$4,$5,'2026-10-01'::timestamptz + $6 * interval '1 microsecond')`,
        [id, ownerId, conversationId, i % 2 ? 'assistant' : 'user', `history ${i}`, i],
      );
    }
    await pool.query(
      `INSERT INTO messages(id,owner_id,conversation_id,role,content)
      VALUES($1,$2,$3,'system','private system')`,
      [randomUUID(), ownerId, conversationId],
    );
    const deps = dependencies(pool);
    const input = `完整输入\r\n${'😀'.repeat(9000)}\n尾部`;
    const started = await startConversationRun(
      deps,
      ownerId,
      randomUUID(),
      {
        execution: 'harness',
        conversation_id: conversationId,
        raw_text: input,
      },
      randomUUID(),
    );
    const run = (
      await pool.query('SELECT frozen_context,input_message_id FROM agent_runs WHERE id=$1', [
        started.runId,
      ])
    ).rows[0];
    expect(run.frozen_context.messageRefs).toEqual([
      ...predecessors.slice(-63),
      run.input_message_id,
    ]);
    expect(started.context?.inputText).toBe(input);
    expect(
      (await pool.query('SELECT content FROM messages WHERE id=$1', [run.input_message_id])).rows[0]
        ?.content,
    ).toBe(input);
    expect(await readRunContextPolicy(pool, ownerId, started.runId)).toEqual(policy);
    expect(started.context?.messageRefs).toEqual(run.frozen_context.messageRefs);
    const binding = { ownerId, conversationId, userMessageId: run.input_message_id };
    const visible = await readHarnessMessages(pool, binding, run.frozen_context.messageRefs);
    const laterId = randomUUID();
    await pool.query(
      `INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'assistant','must not enter frozen input')`,
      [laterId, ownerId, conversationId],
    );
    expect(await readHarnessMessages(pool, binding, run.frozen_context.messageRefs)).toEqual(
      visible,
    );
    expect(visible.at(-1)?.content).toBe(input);
    expect(visible.map((message) => message.message_id)).not.toContain(laterId);
  });

  it('keeps deployment changes and same inbound replay from replacing the accepted policy', async () => {
    const ownerId = randomUUID(),
      key = randomUUID();
    await database.pool.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
      ownerId,
      `${ownerId}@context.test`,
    ]);
    await admitTestUser(database.pool, ownerId);
    await configureTestModel(database.pool, ownerId, 'context-fixture');
    const body = { execution: 'harness', raw_text: 'frozen policy input' };
    const started = await startConversationRun(
      dependencies(database.pool),
      ownerId,
      randomUUID(),
      body,
      key,
    );
    const before = (
      await database.pool.query('SELECT * FROM agent_runs WHERE id=$1', [started.runId])
    ).rows[0];
    const changed = createContextPolicy({
      completionCap: 1024,
      model: 'changed-model',
      reserveTokens: 100,
    });
    const replay = await startConversationRun(
      dependencies(database.pool, changed),
      ownerId,
      randomUUID(),
      body,
      key,
    );
    expect(replay.runId).toBe(started.runId);
    expect(replay.context).toBeNull();
    expect(await readRunContextPolicy(database.pool, ownerId, started.runId)).toEqual(policy);
    expect(
      (await database.pool.query('SELECT * FROM agent_runs WHERE id=$1', [started.runId])).rows[0],
    ).toEqual(before);
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int n FROM run_context_policies WHERE run_id=$1',
          [started.runId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await database.pool.query('SELECT count(*)::int n FROM agent_runs WHERE owner_id=$1', [
          ownerId,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it('GET and policy reads on a legacy Run remain zero-write and new business Runs get no policy', async () => {
    const pool = database.pool;
    const binding = await legacy();
    const before = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [binding.runId]))
      .rows[0];
    expect(await readRunContextPolicy(pool, binding.ownerId, binding.runId)).toBeNull();
    const view = await getRunView(
      dependencies(pool),
      binding.ownerId,
      binding.conversationId,
      binding.runId,
    );
    expect(view.run_id).toBe(binding.runId);
    expect(await readRunContextPolicy(pool, binding.ownerId, binding.runId)).toBeNull();
    expect(
      (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [binding.runId])).rows[0],
    ).toEqual(before);
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM run_attempts WHERE run_id=$1', [
          binding.runId,
        ])
      ).rows[0].n,
    ).toBe(1);
    const business = await startConversationRun(
      dependencies(pool),
      binding.ownerId,
      randomUUID(),
      { raw_text: 'business chat' },
      randomUUID(),
    );
    expect(await readRunContextPolicy(pool, binding.ownerId, business.runId)).toBeNull();
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM run_context_policies WHERE run_id=ANY($1::uuid[])',
          [[binding.runId, business.runId]],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('concurrent ensure retains exactly one immutable winner without changing original authority', async () => {
    const pool = database.pool,
      binding = await legacy();
    const before = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [binding.runId]))
      .rows[0];
    const other = createContextPolicy({ completionCap: 768, model: 'other-deployment' });
    const accepted = await Promise.all(
      [policy, other].map((candidate) =>
        withTransaction(pool, (client) =>
          ensureRunContextPolicy(client, binding.ownerId, binding.runId, candidate),
        ),
      ),
    );
    expect(accepted[0]).toEqual(accepted[1]);
    expect([policy.completion_cap, other.completion_cap]).toContain(accepted[0]!.completion_cap);
    const rows = (
      await pool.query('SELECT * FROM run_context_policies WHERE run_id=$1', [binding.runId])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].policy_hash).toBe(digestContextPolicy(accepted[0]!));
    expect(
      (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [binding.runId])).rows[0],
    ).toEqual(before);
    await expect(
      pool.query('UPDATE run_context_policies SET policy=policy WHERE run_id=$1', [binding.runId]),
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      pool.query('DELETE FROM run_context_policies WHERE run_id=$1', [binding.runId]),
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      pool.query(
        'INSERT INTO run_context_policies SELECT * FROM run_context_policies WHERE run_id=$1',
        [binding.runId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rolls back policy and the new attempt together on a failed resume transaction', async () => {
    const pool = database.pool,
      binding = await legacy();
    const before = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [binding.runId]))
      .rows[0];
    await expect(
      withTransaction(pool, async (client) => {
        await ensureRunContextPolicy(client, binding.ownerId, binding.runId, policy);
        await client.query(
          `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,2,'running')`,
          [randomUUID(), binding.ownerId, binding.runId],
        );
        throw new Error('resume rejected');
      }),
    ).rejects.toThrow('resume rejected');
    expect(await readRunContextPolicy(pool, binding.ownerId, binding.runId)).toBeNull();
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM run_attempts WHERE run_id=$1', [
          binding.runId,
        ])
      ).rows[0].n,
    ).toBe(1);
    expect(
      (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [binding.runId])).rows[0],
    ).toEqual(before);
  });

  it('rolls back all new admission facts when policy validation fails', async () => {
    const pool = database.pool,
      ownerId = randomUUID();
    await pool.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
      ownerId,
      `${ownerId}@context.test`,
    ]);
    await admitTestUser(pool, ownerId);
    await expect(
      startConversationRun(
        dependencies(pool, { ...policy, completion_cap: 0 }),
        ownerId,
        randomUUID(),
        { execution: 'harness', raw_text: 'must roll back' },
        randomUUID(),
      ),
    ).rejects.toThrow();
    for (const table of [
      'conversations',
      'messages',
      'agent_runs',
      'run_attempts',
      'run_context_policies',
      'conversation_idempotency',
    ]) {
      expect(
        (await pool.query(`SELECT count(*)::int n FROM ${table} WHERE owner_id=$1`, [ownerId]))
          .rows[0].n,
      ).toBe(0);
    }
  });

  it('database rejects owner mismatch, business binding and invalid strict policy payloads', async () => {
    const pool = database.pool,
      binding = await legacy(),
      business = await legacy('business');
    const insert = (
      runId: string,
      ownerId: string,
      value: unknown,
      hash = digestContextPolicy(policy),
    ) =>
      pool.query(
        'INSERT INTO run_context_policies(run_id,owner_id,policy,policy_hash) VALUES($1,$2,$3::jsonb,$4)',
        [runId, ownerId, JSON.stringify(value), hash],
      );
    await expect(insert(binding.runId, business.ownerId, policy)).rejects.toMatchObject({
      code: 'P0001',
    });
    await expect(insert(business.runId, business.ownerId, policy)).rejects.toMatchObject({
      code: 'P0001',
    });
    for (const invalid of [
      { ...policy, extra: true },
      { ...policy, completion_cap: 0 },
      { ...policy, completion_cap: 1.5 },
      { ...policy, completion_cap: Number.MAX_SAFE_INTEGER + 1 },
      { ...policy, model_window_tokens: 0 },
      { ...policy, reserve_tokens: -1 },
      { ...policy, input_meter: 'verified' },
      { ...policy, input_meter: 'unknown' },
      { ...policy, model_binding: { ...policy.model_binding, endpoint: 'not-allowed' } },
      { ...policy, model_binding: { ...policy.model_binding, model: '' } },
    ])
      await expect(insert(binding.runId, binding.ownerId, invalid)).rejects.toMatchObject({
        code: '23514',
      });
    await expect(
      insert(binding.runId, binding.ownerId, policy, 'not-a-hash'),
    ).rejects.toMatchObject({ code: '23514' });
    await insert(binding.runId, binding.ownerId, policy);
    expect(await readRunContextPolicy(pool, business.ownerId, binding.runId)).toBeNull();
    await expect(
      withTransaction(pool, (client) =>
        ensureRunContextPolicy(client, business.ownerId, binding.runId, policy),
      ),
    ).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
  });

  it('rejects a stored digest that does not cover the strict policy bytes', async () => {
    const binding = await legacy();
    await database.pool.query(
      'INSERT INTO run_context_policies(run_id,owner_id,policy,policy_hash) VALUES($1,$2,$3::jsonb,$4)',
      [binding.runId, binding.ownerId, JSON.stringify(policy), '0'.repeat(64)],
    );
    await expect(
      readRunContextPolicy(database.pool, binding.ownerId, binding.runId),
    ).rejects.toMatchObject({ errorCode: 'HARNESS_PROTOCOL_ERROR' });
  });

  it('rejects duplicate, foreign-owner, missing and non-user final frozen message references', async () => {
    const pool = database.pool,
      binding = await legacy(),
      other = await legacy();
    for (const refs of [
      [],
      [binding.userMessageId, binding.userMessageId],
      [other.userMessageId, binding.userMessageId],
      [randomUUID(), binding.userMessageId],
    ]) {
      await expect(readHarnessMessages(pool, binding, refs)).rejects.toMatchObject({
        errorCode: 'STATE_CONFLICT',
      });
    }
    const assistant = randomUUID();
    await pool.query(
      `INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'assistant','not input')`,
      [assistant, binding.ownerId, binding.conversationId],
    );
    await expect(
      readHarnessMessages(pool, { ...binding, userMessageId: assistant }, [assistant]),
    ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
  });
});
