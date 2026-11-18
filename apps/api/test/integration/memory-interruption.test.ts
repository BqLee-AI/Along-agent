import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../src/db/transaction.js';
import { interruptedGoalResult } from '../../src/agent/operations/goal-result.js';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';
import { seedContext } from './tool-invocations-probe.js';

const maybe = databaseUrl ? describe : describe.skip;
maybe('interrupted memory save', () => {
  let database: IntegrationDatabase;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });
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
});
