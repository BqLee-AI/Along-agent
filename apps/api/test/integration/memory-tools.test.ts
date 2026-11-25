import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../src/db/transaction.js';
import { conversationMemorySources } from '../../src/features/conversations/history/memory-sources.js';
import { createMemoryService } from '../../src/features/memory/service.js';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import { readInvocationSnapshots } from '../../src/agent/tools/invocations/invocations.js';
import { readRunContextObservations } from '../../src/agent/tools/invocations/context-query.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';
import { seedContext } from './tool-invocations-probe.js';
import { interruptedGoalResult } from '../../src/agent/execution/result/goal-result.js';

const maybe = databaseUrl ? describe : describe.skip;
maybe('memory tools and receipts', () => {
  let database: IntegrationDatabase;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });
  for (const [change, profile] of [
    ['correct', 'pause-memory/1'],
    ['stop', 'pause-memory/1'],
    ['correct', 'compact-memory/1'],
    ['stop', 'compact-memory/1'],
  ] as const) {
    it(`revalidates ${profile} accepted observations after ${change}`, async () => {
      const base = await seedContext(database.pool);
      const message = randomUUID();
      const runId = randomUUID();
      const attemptId = randomUUID();
      const allowlist = [
        'remember_memory',
        'recall_memories',
        ...(profile === 'compact-memory/1' ? ['read_memory_source'] : []),
      ];
      await database.pool.query(
        "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','remember old value')",
        [message, base.ownerId, base.conversationId],
      );
      await database.pool.query(
        `INSERT INTO agent_runs
         (id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,tools_allowlist,frozen_context)
         VALUES($1,$2,$3,'test','chat','running',10,10000,'harness',$4,$5::jsonb,$6::jsonb)`,
        [
          runId,
          base.ownerId,
          base.conversationId,
          message,
          JSON.stringify(allowlist),
          JSON.stringify({
            execution_profile: profile,
            execution_lifecycle: 'request-bound',
          }),
        ],
      );
      await database.pool.query(
        "INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'running')",
        [attemptId, base.ownerId, runId],
      );
      const ctx = { ...base, runId, attemptId, allowlist };
      const memory = createMemoryService({
        pool: database.pool,
        sources: conversationMemorySources,
      });
      const saved = await memory.remember(ctx.ownerId, {
        conversationId: ctx.conversationId,
        messageIds: [message],
        content: 'old value',
        idempotencyKey: randomUUID(),
      });
      const args = { query: 'old value' };
      const toolId = 'recall_memories';
      const reserved = await reserveToolInvocation(database.pool, ctx, {
        callKey: randomUUID(),
        toolId,
        args,
      });
      const input = { ...reserved, toolId, args };
      expect(await invokeTool(database.pool, ctx, input)).toMatchObject({
        status: 'ok',
        replayed: false,
        result: {
          kind: 'memory_recall',
          completeness: 'degraded',
          items: [
            {
              content: 'old value',
              ...(profile === 'compact-memory/1' ? { match: 'literal' } : {}),
            },
          ],
        },
      });
      expect(await invokeTool(database.pool, ctx, input)).toMatchObject({
        status: 'ok',
        replayed: true,
      });
      const receipt = await database.pool.query(
        'SELECT revisions FROM r3_memory_recall_receipts WHERE invocation_id=$1',
        [input.invocationId],
      );
      let sourceInput: { invocationId: string; toolId: string; args: unknown } | undefined;
      if (profile === 'compact-memory/1') {
        const toolId = 'read_memory_source';
        const args = {
          recall_invocation_id: input.invocationId,
          memory_id: saved.id,
          message_id: message,
          offset: 0,
          limit: 100,
        };
        const reserved = await reserveToolInvocation(database.pool, ctx, {
          callKey: randomUUID(),
          toolId,
          args,
        });
        sourceInput = { ...reserved, toolId, args };
        expect(await invokeTool(database.pool, ctx, sourceInput)).toMatchObject({
          status: 'ok',
          result: { kind: 'memory_source', content: 'remember old value' },
        });
      }
      expect(receipt.rows[0]?.revisions).toEqual([{ id: saved.id, revision: 1 }]);
      if (change === 'correct')
        await memory.correct(ctx.ownerId, saved.id, {
          conversationId: ctx.conversationId,
          messageIds: [message],
          content: 'new value',
          expectedRevision: 1,
        });
      else await memory.stopRecall(ctx.ownerId, saved.id, 1);
      if (sourceInput)
        expect(await invokeTool(database.pool, ctx, sourceInput)).toMatchObject({
          status: 'denied',
        });
      expect(await invokeTool(database.pool, ctx, input)).toMatchObject({ status: 'denied' });
      await expect(
        withTransaction(database.pool, (client) =>
          readRunContextObservations(client, ctx, [input.invocationId], { project: false }),
        ),
      ).rejects.toThrow();
      await expect(
        withTransaction(database.pool, (client) =>
          readInvocationSnapshots(client, ctx, [input.invocationId]),
        ),
      ).rejects.toThrow();
    });
  }

  it('retains an accepted save in the interrupted goal', async () => {
    const base = await seedContext(database.pool);
    const message = randomUUID();
    const runId = randomUUID();
    const attemptId = randomUUID();
    const allowlist = ['remember_memory'];
    await database.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','remember my preference')",
      [message, base.ownerId, base.conversationId],
    );
    await database.pool.query(
      `INSERT INTO agent_runs (id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,tools_allowlist,frozen_context) VALUES($1,$2,$3,'test','chat','running',10,10000,'harness',$4,$5::jsonb,$6::jsonb)`,
      [
        runId,
        base.ownerId,
        base.conversationId,
        message,
        JSON.stringify(allowlist),
        JSON.stringify({
          execution_profile: 'pause-memory/1',
          execution_lifecycle: 'request-bound',
          authorization_revision: 'delegation/1',
        }),
      ],
    );
    await database.pool.query(
      "INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'running')",
      [attemptId, base.ownerId, runId],
    );
    const ctx = {
      ...base,
      runId,
      attemptId,
      allowlist,
      authorizationRevision: 'delegation/1' as const,
    };
    const toolId = 'remember_memory';
    const args = { content: 'my preference' };
    const reserved = await reserveToolInvocation(database.pool, ctx, {
      callKey: randomUUID(),
      toolId,
      args,
    });
    expect('invocationId' in reserved).toBe(true);
    if (!('invocationId' in reserved)) throw new Error('unexpected pause');
    const result = await invokeTool(database.pool, ctx, { ...reserved, toolId, args });
    expect(result).toMatchObject({ status: 'ok', result: { kind: 'memory_saved' } });
    const goal = await withTransaction(database.pool, (client) =>
      interruptedGoalResult(client, ctx, 'failed'),
    );
    expect(goal.status).toBe('partial');
    expect(goal.outcomes).toContainEqual(
      expect.objectContaining({ status: 'achieved', receipt_refs: [reserved.invocationId] }),
    );
  });

  it('accepts and replays an incomplete prefix when matching memories exceed the ledger budget', async () => {
    const base = await seedContext(database.pool);
    const message = randomUUID(),
      runId = randomUUID(),
      attemptId = randomUUID();
    const allowlist = ['recall_memories'];
    await database.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','source')",
      [message, base.ownerId, base.conversationId],
    );
    await database.pool.query(
      `INSERT INTO agent_runs (id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,input_message_id,tools_allowlist,frozen_context) VALUES($1,$2,$3,'test','chat','running',10,10000,'harness',$4,$5::jsonb,$6::jsonb)`,
      [
        runId,
        base.ownerId,
        base.conversationId,
        message,
        JSON.stringify(allowlist),
        JSON.stringify({
          execution_profile: 'pause-memory/1',
          execution_lifecycle: 'request-bound',
        }),
      ],
    );
    await database.pool.query(
      "INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'running')",
      [attemptId, base.ownerId, runId],
    );
    const ctx = { ...base, runId, attemptId, allowlist };
    const memory = createMemoryService({ pool: database.pool, sources: conversationMemorySources });
    for (let i = 0; i < 7; i++)
      await memory.remember(ctx.ownerId, {
        conversationId: ctx.conversationId,
        messageIds: [message],
        content: '共同' + '字'.repeat(11997) + i,
        idempotencyKey: randomUUID(),
      });
    const toolId = 'recall_memories',
      args = { query: '共同' };
    const reserved = await reserveToolInvocation(database.pool, ctx, {
      callKey: randomUUID(),
      toolId,
      args,
    });
    if (!('invocationId' in reserved)) throw new Error('unexpected pause');
    const input = { ...reserved, toolId, args };
    const result = await invokeTool(database.pool, ctx, input);
    expect(result).toMatchObject({
      status: 'ok',
      result: { kind: 'memory_recall', completeness: 'incomplete' },
    });
    if (result.status !== 'ok' || result.result.kind !== 'memory_recall')
      throw new Error('recall failed');
    expect(result.result.items.length).toBeGreaterThan(0);
    expect(result.result.items.length).toBeLessThan(7);
    expect(result.result.items.every((item) => item.content.length === 12000)).toBe(true);
    expect(await invokeTool(database.pool, ctx, input)).toMatchObject({
      status: 'ok',
      replayed: true,
      result: result.result,
    });
  });
});
