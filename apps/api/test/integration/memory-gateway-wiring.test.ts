import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../src/db/transaction.js';
import { conversationMemorySources } from '../../src/modules/conversations/memory-sources.js';
import { createMemoryService } from '../../src/modules/memory/service.js';
import { invokeTool, reserveToolInvocation } from '../../src/modules/tools/gateway.js';
import { readInvocationSnapshots } from '../../src/modules/tools/invocations.js';
import { readRunContextObservations } from '../../src/modules/tools/query.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';
import { seedContext } from './tool-invocations-probe.js';

const maybe = databaseUrl ? describe : describe.skip;
maybe('literal memory gateway receipts', () => {
  let database: IntegrationDatabase;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });
  for (const change of ['correct', 'stop'] as const) {
    it(`revalidates the accepted observation after ${change}`, async () => {
      const base = await seedContext(database.pool);
      const message = randomUUID();
      const runId = randomUUID();
      const attemptId = randomUUID();
      const allowlist = ['remember_memory', 'recall_memories'];
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
          items: [{ content: 'old value' }],
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
      expect(receipt.rows[0]?.revisions).toEqual([{ id: saved.id, revision: 1 }]);
      if (change === 'correct')
        await memory.correct(ctx.ownerId, saved.id, {
          conversationId: ctx.conversationId,
          messageIds: [message],
          content: 'new value',
          expectedRevision: 1,
        });
      else await memory.stopRecall(ctx.ownerId, saved.id, 1);
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
});
