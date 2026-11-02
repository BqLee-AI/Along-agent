import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import { invokeTool, reserveToolInvocation } from '../../src/modules/tools/gateway.js';
import {
  executeNonTransactionalInvocation,
  readInvocationSnapshots,
  readRunInvocationStates,
  reserveInvocation,
} from '../../src/modules/tools/invocations.js';
import type { ToolContext, ToolOutcome, ToolResult } from '../../src/modules/tools/contracts.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const tools = ['propose_task', 'get_user_prefs'];

maybe('read-only accepted invocation bootstrap', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });

  async function fresh(ownerId: string = randomUUID()): Promise<ToolContext> {
    await pool.query(
      `INSERT INTO users(id,auth_email,display_name,timezone_id) VALUES($1,$2,'tester','Asia/Shanghai')
       ON CONFLICT(id) DO NOTHING`,
      [ownerId, `${ownerId}@fixture.test`],
    );
    const started = await startConversationRun(
      { pool, timeContext: loadTimeContext('fixture-v1') },
      ownerId,
      randomUUID(),
      { raw_text: '2026-11-02 09:20提醒我喝水', confirmed_timezone: 'Asia/Shanghai' },
      randomUUID(),
    );
    if (!started.context) throw new Error('expected a fresh run');
    return { ...started.context, allowlist: tools };
  }

  async function accepted(ctx: ToolContext, toolId = 'get_user_prefs', args: unknown = {}) {
    const { invocationId } = await reserveToolInvocation(pool, ctx, {
      callKey: randomUUID(),
      toolId,
      args,
    });
    const outcome = await invokeTool(pool, ctx, { invocationId, toolId, args });
    return { invocationId, toolId, outcome };
  }

  function resultOf(outcome: ToolOutcome): ToolResult {
    return outcome.status === 'ok'
      ? { status: outcome.status, result: outcome.result }
      : { status: outcome.status, error: outcome.error };
  }

  it('returns ordered immutable accepted observations without effects or audit writes, even after approval decisions', async () => {
    const ctx = await fresh();
    const prefs = await accepted(ctx);
    const proposal = await accepted(ctx, 'propose_task', {
      raw_time_text: '2026-11-02 09:20',
      note: '喝水',
      occurrence: 'once',
    });
    if (proposal.outcome.status !== 'ok' || proposal.outcome.result.kind !== 'approval')
      throw new Error('expected approval');
    await pool.query("UPDATE users SET timezone_id='Europe/Paris' WHERE id=$1", [ctx.ownerId]);
    await pool.query("UPDATE run_attempts SET status='done' WHERE id=$1", [ctx.attemptId]);
    await pool.query("UPDATE agent_runs SET status='done' WHERE id=$1", [ctx.runId]);
    const before = await pool.query(
      'SELECT * FROM tool_invocations WHERE run_id=$1 ORDER BY invocation_id',
      [ctx.runId],
    );
    const auditBefore = await pool.query('SELECT * FROM tool_calls WHERE run_id=$1 ORDER BY id', [
      ctx.runId,
    ]);
    const client = await pool.connect();
    try {
      for (const state of ['consumed', 'rejected', 'expired', 'superseded']) {
        await pool.query('UPDATE approvals SET state=$2 WHERE id=$1', [
          proposal.outcome.result.approval.approvalId,
          state,
        ]);
        await client.query('BEGIN READ ONLY');
        try {
          expect(
            await readInvocationSnapshots(
              client,
              { ...ctx, timeContext: loadTimeContext(undefined) },
              [proposal.invocationId, prefs.invocationId],
            ),
          ).toEqual([
            {
              invocation_id: proposal.invocationId,
              tool_id: proposal.toolId,
              result: resultOf(proposal.outcome),
            },
            {
              invocation_id: prefs.invocationId,
              tool_id: prefs.toolId,
              result: resultOf(prefs.outcome),
            },
          ]);
          expect(await readInvocationSnapshots(client, ctx, [])).toEqual([]);
        } finally {
          await client.query('ROLLBACK');
        }
      }
    } finally {
      client.release();
    }
    expect(
      (
        await pool.query('SELECT * FROM tool_invocations WHERE run_id=$1 ORDER BY invocation_id', [
          ctx.runId,
        ])
      ).rows,
    ).toEqual(before.rows);
    expect(
      (await pool.query('SELECT * FROM tool_calls WHERE run_id=$1 ORDER BY id', [ctx.runId])).rows,
    ).toEqual(auditBefore.rows);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM tasks WHERE owner_id=$1', [ctx.ownerId]))
        .rows[0],
    ).toEqual({ n: 0 });
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM approvals WHERE owner_id=$1', [
          ctx.ownerId,
        ])
      ).rows[0],
    ).toEqual({ n: 1 });
  });

  it('masks revoked tools without rewriting accepted facts or upgrading an originally denied result', async () => {
    const ctx = await fresh();
    const prefs = await accepted(ctx);
    const denied = await accepted({ ...ctx, allowlist: [] });
    const client = await pool.connect();
    try {
      expect(
        await readInvocationSnapshots(client, { ...ctx, allowlist: [] }, [prefs.invocationId]),
      ).toEqual([
        {
          invocation_id: prefs.invocationId,
          tool_id: prefs.toolId,
          result: {
            status: 'denied',
            error: { code: 'TOOL_DENIED', message: 'tool not in allowlist' },
          },
        },
      ]);
      expect(
        await readInvocationSnapshots(client, ctx, [prefs.invocationId, denied.invocationId]),
      ).toEqual([
        {
          invocation_id: prefs.invocationId,
          tool_id: prefs.toolId,
          result: resultOf(prefs.outcome),
        },
        {
          invocation_id: denied.invocationId,
          tool_id: denied.toolId,
          result: resultOf(denied.outcome),
        },
      ]);
    } finally {
      client.release();
    }
  });

  it('rejects missing, foreign-owner, foreign-conversation, foreign-Run and incomplete references', async () => {
    const ctx = await fresh();
    const otherOwner = await fresh();
    const otherRun = await fresh(ctx.ownerId);
    const fact = await accepted(ctx);
    const reserved = await reserveToolInvocation(pool, ctx, {
      callKey: 'pending/1',
      toolId: 'get_user_prefs',
      args: {},
    });
    const unknown = await reserveInvocation(pool, ctx, {
      callKey: 'unknown/1',
      toolId: 'get_user_prefs',
      args: {},
      executionKind: 'non_transactional',
    });
    await executeNonTransactionalInvocation(
      pool,
      ctx,
      { invocationId: unknown.invocationId, toolId: 'get_user_prefs', args: {} },
      {
        execute: async () => {
          throw new Error('lost effect answer');
        },
      },
    );
    const client = await pool.connect();
    try {
      for (const reader of [otherOwner, otherRun]) {
        await expect(
          readInvocationSnapshots(client, reader, [fact.invocationId]),
        ).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
        expect(await readRunInvocationStates(client, reader)).toEqual([]);
      }
      for (const reader of [
        { ...ctx, conversationId: otherRun.conversationId },
        { ...ctx, runId: otherRun.runId },
        { ...ctx, ownerId: otherOwner.ownerId },
      ]) {
        await expect(
          readInvocationSnapshots(client, reader, [fact.invocationId]),
        ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
        await expect(readInvocationSnapshots(client, reader, [])).rejects.toMatchObject({
          errorCode: 'FORBIDDEN',
        });
        await expect(readRunInvocationStates(client, reader)).rejects.toMatchObject({
          errorCode: 'FORBIDDEN',
        });
      }
      await client.query('BEGIN READ ONLY');
      try {
        const states = await readRunInvocationStates(client, ctx);
        expect(states).toHaveLength(3);
        expect(states).toContainEqual({
          invocation_id: fact.invocationId,
          call_key: expect.any(String),
          tool_id: fact.toolId,
          approval_ref: null,
          state: 'completed',
          outcome_kind: 'success',
          approval_id: null,
        });
        expect(states).toContainEqual({
          invocation_id: reserved.invocationId,
          call_key: 'pending/1',
          tool_id: 'get_user_prefs',
          approval_ref: null,
          state: 'reserved',
          outcome_kind: null,
          approval_id: null,
        });
        expect(states).toContainEqual({
          invocation_id: unknown.invocationId,
          call_key: 'unknown/1',
          tool_id: 'get_user_prefs',
          approval_ref: null,
          state: 'unknown',
          outcome_kind: null,
          approval_id: null,
        });
      } finally {
        await client.query('ROLLBACK');
      }
      await expect(
        readInvocationSnapshots(client, ctx, [fact.invocationId, randomUUID()]),
      ).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });
      for (const { invocationId } of [reserved, unknown]) {
        await expect(
          readInvocationSnapshots(client, { ...ctx, allowlist: [] }, [invocationId]),
        ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
      }
    } finally {
      client.release();
    }
    expect(
      (
        await pool.query(
          'SELECT state,accepted_result FROM tool_invocations WHERE invocation_id=$1',
          [unknown.invocationId],
        )
      ).rows[0],
    ).toEqual({ state: 'unknown', accepted_result: null });
  });
});
