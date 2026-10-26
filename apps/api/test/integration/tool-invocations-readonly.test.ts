import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  executeReadOnlyInvocation,
  reserveInvocation,
} from '../../src/modules/tools/invocations.js';
import type { ToolContext, ToolResult } from '../../src/modules/tools/contracts.js';
import { seedContext } from './tool-invocations-probe.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const toolId = 'internal.read-probe';
const args = { path: 'memo.txt' };
const observation = (value: string): ToolResult => ({
  status: 'ok',
  result: { kind: 'effect_evidence', evidence_ref: value },
});

maybe('external read first acceptance and cancellation', () => {
  let database: IntegrationDatabase;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });

  async function reserve() {
    const ctx: ToolContext = { ...(await seedContext(database.pool)), allowlist: [toolId] };
    const { invocationId } = await reserveInvocation(database.pool, ctx, {
      callKey: 'read/1',
      toolId,
      args,
      executionKind: 'read_only',
    });
    return { ctx, input: { invocationId, toolId, args } };
  }

  it('competing external reads accept only the first result and replay performs zero IO', async () => {
    const { ctx, input } = await reserve();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const slow = executeReadOnlyInvocation(database.pool, ctx, input, async () => {
      calls++;
      entered.resolve();
      await release.promise;
      return observation('later-source-version');
    });
    await entered.promise;
    try {
      const first = await executeReadOnlyInvocation(database.pool, ctx, input, async () => {
        calls++;
        return observation('first-accepted-version');
      });
      release.resolve();
      expect(await slow).toEqual({ ...first, replayed: true });
      const replay = await executeReadOnlyInvocation(database.pool, ctx, input, async () => {
        calls++;
        throw new Error('completed reads must not reach IO');
      });
      expect(replay).toEqual({ ...first, replayed: true });
      expect(calls).toBe(2);
      const rows = await database.pool.query(
        "SELECT record_kind FROM tool_calls WHERE invocation_id=$1 AND record_kind='accepted'",
        [input.invocationId],
      );
      expect(rows.rowCount).toBe(1);
    } finally {
      release.resolve();
      await slow;
    }
  });

  it('cancellation commits without waiting for external IO and late data is neither accepted nor disclosed', async () => {
    const { ctx, input } = await reserve();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = executeReadOnlyInvocation(database.pool, ctx, input, async () => {
      entered.resolve();
      await release.promise;
      return observation('private-late-content');
    });
    await entered.promise;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='1000ms'");
      await client.query(
        "UPDATE run_attempts SET status='fenced_out',ended_at=clock_timestamp() WHERE id=$1",
        [ctx.attemptId],
      );
      await client.query(
        "UPDATE agent_runs SET status='cancelled',ended_at=clock_timestamp() WHERE id=$1",
        [ctx.runId],
      );
      await client.query('COMMIT');
      release.resolve();
      expect(await pending).toMatchObject({ status: 'denied' });
      expect('result' in (await pending)).toBe(false);
      expect(
        (
          await database.pool.query(
            'SELECT state,accepted_result FROM tool_invocations WHERE invocation_id=$1',
            [input.invocationId],
          )
        ).rows[0],
      ).toEqual({ state: 'reserved', accepted_result: null });
    } finally {
      await client.query('ROLLBACK');
      client.release();
      release.resolve();
      await pending;
    }
  });

  it('a superseded attempt cannot accept data after a newer attempt starts', async () => {
    const { ctx, input } = await reserve();
    const result = await executeReadOnlyInvocation(database.pool, ctx, input, async () => {
      await database.pool.query(
        'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,2)',
        [randomUUID(), ctx.ownerId, ctx.runId],
      );
      return observation('stale-attempt-content');
    });
    expect(result.status).toBe('denied');
    expect('result' in result).toBe(false);
  });

  it('revoking tool permission during IO denies acceptance without storing source bytes', async () => {
    const { ctx, input } = await reserve();
    const result = await executeReadOnlyInvocation(database.pool, ctx, input, async () => {
      ctx.allowlist = [];
      return observation('revoked-private-content');
    });
    expect(result.status).toBe('denied');
    expect('result' in result).toBe(false);
    const row = (
      await database.pool.query(
        'SELECT accepted_result FROM tool_invocations WHERE invocation_id=$1',
        [input.invocationId],
      )
    ).rows[0];
    expect(JSON.stringify(row)).not.toContain('revoked-private-content');
  });
});
