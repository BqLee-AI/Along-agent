import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { conversationMemorySources } from '../../src/modules/conversations/memory-sources.js';
import { createMemoryService } from '../../src/modules/memory/service.js';
import { invokeTool, reserveToolInvocation } from '../../src/modules/tools/gateway.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';
import { seedContext } from './tool-invocations-probe.js';

const maybe = databaseUrl ? describe : describe.skip;
maybe('bounded recall result', () => {
  let database: IntegrationDatabase;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await database?.close();
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
