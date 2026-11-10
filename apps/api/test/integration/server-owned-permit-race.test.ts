import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunOwnership } from '../../src/modules/conversations/run-ownership.js';
import { cancelConversationRun } from '../../src/modules/conversations/service.js';
import {
  executeNonTransactionalInvocation,
  reserveInvocation,
} from '../../src/modules/tools/invocations.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';
import { appendFileEffect } from './tool-invocations-file-effect.js';
import { args, fileLines, seedContext, toolId } from './tool-invocations-probe.js';

const maybe = databaseUrl ? describe : describe.skip;

maybe('server-owned one-time external dispatch permit', () => {
  let database: IntegrationDatabase;
  let directory: string;

  beforeAll(async () => {
    database = await createIntegrationDatabase();
    directory = await mkdtemp(join(tmpdir(), 'along-owned-permit-'));
  });
  afterAll(async () => {
    try {
      await database?.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  async function fixture() {
    const base = await seedContext(database.pool);
    const runId = randomUUID();
    const attemptId = randomUUID();
    await database.pool.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,
         budget_max_iterations,budget_max_tokens,frozen_context)
       SELECT $2,owner_id,conversation_id,agent_revision,mode,
         budget_max_iterations,budget_max_tokens,
         jsonb_build_object('execution_lifecycle','server-owned')
       FROM agent_runs WHERE id=$1`,
      [base.runId, runId],
    );
    const owner = await RunOwnership.tryAcquire(database.pool, runId);
    if (!owner) throw new Error('fixture could not acquire Run ownership');
    await database.pool.query(
      'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,lease_token) VALUES($1,$2,$3,1,$4)',
      [attemptId, base.ownerId, runId, owner.token],
    );
    const ctx = { ...base, runId, attemptId, ownership: owner };
    const { invocationId } = await reserveInvocation(database.pool, ctx, {
      callKey: 'one-external-effect',
      toolId,
      args,
      executionKind: 'non_transactional',
    });
    return { ctx, owner, input: { invocationId, toolId, args } };
  }

  async function persisted(invocationId: string) {
    return (
      await database.pool.query<{
        invocation_id: string;
        state: string;
        args_hash: string;
        accepted_result: unknown;
        evidence_ref: string | null;
      }>(
        'SELECT invocation_id,state,args_hash,accepted_result,evidence_ref FROM tool_invocations WHERE invocation_id=$1',
        [invocationId],
      )
    ).rows[0]!;
  }

  it('a committed stop before dispatch leaves the reservation untouched and produces no file effect', async () => {
    const { ctx, owner, input } = await fixture();
    const control = database.connect();
    const path = join(directory, `${input.invocationId}.jsonl`);
    try {
      const stopped = await cancelConversationRun(
        { pool: control, timeContext: ctx.timeContext },
        ctx.ownerId,
        ctx.conversationId,
        ctx.runId,
        randomUUID(),
        { idempotency_key: randomUUID() },
      );
      expect(stopped.status).toBe('cancelled');
      const result = await executeNonTransactionalInvocation(database.pool, ctx, input, {
        execute: (binding) => appendFileEffect(path, binding),
      });
      expect(result).toMatchObject({ invocationId: input.invocationId, status: 'denied' });
      expect(await fileLines(path)).toEqual([]);
      expect(await persisted(input.invocationId)).toMatchObject({
        invocation_id: input.invocationId,
        state: 'reserved',
        accepted_result: null,
        evidence_ref: null,
      });
    } finally {
      await owner.close();
      await control.end();
    }
  }, 30000);

  it('a stop after dispatch records the late real effect but does not disclose it', async () => {
    const { ctx, owner, input } = await fixture();
    const control = database.connect();
    const path = join(directory, `${input.invocationId}.jsonl`);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const running = executeNonTransactionalInvocation(database.pool, ctx, input, {
      execute: async (binding) => {
        entered.resolve();
        await release.promise;
        return appendFileEffect(path, binding);
      },
    });
    try {
      await entered.promise;
      expect(await persisted(input.invocationId)).toMatchObject({
        state: 'unknown',
        accepted_result: null,
      });
      expect(
        (
          await cancelConversationRun(
            { pool: control, timeContext: ctx.timeContext },
            ctx.ownerId,
            ctx.conversationId,
            ctx.runId,
            randomUUID(),
            { idempotency_key: randomUUID() },
          )
        ).status,
      ).toBe('cancelled');
      release.resolve();
      const result = await running;
      expect(result).toMatchObject({ invocationId: input.invocationId, status: 'denied' });
      expect('result' in result).toBe(false);
      const record = await persisted(input.invocationId);
      const lines = await fileLines(path);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({
        invocationId: input.invocationId,
        argsHash: record.args_hash,
        evidenceRef: `file-line:${input.invocationId}:${record.args_hash}`,
      });
      expect(record).toMatchObject({
        invocation_id: input.invocationId,
        state: 'completed',
        evidence_ref: `file-line:${input.invocationId}:${record.args_hash}`,
        accepted_result: { status: 'ok', result: { kind: 'effect_evidence' } },
      });
      expect(
        (await control.query('SELECT status FROM agent_runs WHERE id=$1', [ctx.runId])).rows[0],
      ).toEqual({ status: 'cancelled' });
    } finally {
      release.resolve();
      await running.catch(() => {});
      await owner.close();
      await control.end();
    }
  }, 30000);

  it('ownership loss cannot reissue an unknown permit, and a late effect is accounted without disclosure', async () => {
    const { ctx, owner, input } = await fixture();
    const control = database.connect();
    const path = join(directory, `${input.invocationId}.jsonl`);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let successor: RunOwnership | null = null;
    const pid = await owner.transaction(
      async (client) =>
        (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,
    );
    const running = executeNonTransactionalInvocation(database.pool, ctx, input, {
      execute: async (binding) => {
        entered.resolve();
        await release.promise;
        return appendFileEffect(path, binding);
      },
    });
    try {
      await entered.promise;
      const before = await persisted(input.invocationId);
      expect(before).toMatchObject({
        invocation_id: input.invocationId,
        state: 'unknown',
        accepted_result: null,
      });
      expect(
        (
          await control.query<{ terminated: boolean }>(
            'SELECT pg_terminate_backend($1) AS terminated',
            [pid],
          )
        ).rows[0]?.terminated,
      ).toBe(true);
      await expect(owner.transaction(async () => {})).rejects.toThrow();
      await owner.close();
      successor = await RunOwnership.tryAcquire(control, ctx.runId);
      if (!successor) throw new Error('successor could not acquire released advisory lock');
      await expect(
        executeNonTransactionalInvocation(
          control,
          { ...ctx, ownership: successor, requestId: randomUUID() },
          input,
          { execute: (binding) => appendFileEffect(path, binding) },
        ),
      ).rejects.toThrow();
      expect(await fileLines(path)).toEqual([]);
      expect(await persisted(input.invocationId)).toMatchObject({
        state: 'unknown',
        accepted_result: null,
      });
      release.resolve();
      const late = await running;
      expect(late).toMatchObject({ invocationId: input.invocationId, status: 'denied' });
      expect('result' in late).toBe(false);
      const record = await persisted(input.invocationId);
      const lines = await fileLines(path);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({
        invocationId: input.invocationId,
        argsHash: before.args_hash,
        evidenceRef: `file-line:${input.invocationId}:${before.args_hash}`,
      });
      expect(record).toMatchObject({
        invocation_id: input.invocationId,
        state: 'completed',
        args_hash: before.args_hash,
        evidence_ref: `file-line:${input.invocationId}:${before.args_hash}`,
        accepted_result: { status: 'ok', result: { kind: 'effect_evidence' } },
      });
    } finally {
      release.resolve();
      await running.catch(() => {});
      await owner.close();
      await successor?.close();
      await control.end();
    }
  }, 30000);
});
