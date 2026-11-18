import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskApproval } from '../../src/features/approvals/reminder/create.js';
import {
  executeLocalInvocation,
  executeNonTransactionalInvocation,
  reserveInvocation,
  ToolExecutionError,
} from '../../src/agent/tools/invocations/invocations.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';
import { appendFileEffect, reconcileFileEffect } from './tool-invocations-file-effect.js';
import { args, fileLines, runChild, seedContext, toolId } from './tool-invocations-probe.js';

const maybe = databaseUrl && process.platform === 'linux' ? describe : describe.skip;

maybe('durable invocation real non-transactional boundary', () => {
  let database: IntegrationDatabase;
  let directory: string;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    directory = await mkdtemp(join(tmpdir(), 'along-tool-invocations-'));
  });
  afterAll(async () => {
    try {
      await database?.close();
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it('reserved process death is safe to execute; accepted success replays without a second append', async () => {
    const ctx = await seedContext(database.pool);
    const { invocationId } = await reserveInvocation(database.pool, ctx, {
      callKey: 'reserved-death',
      toolId,
      args,
      executionKind: 'non_transactional',
    });
    const path = join(directory, 'reserved.jsonl');
    await runChild(database, ctx, invocationId, path, 'reserved', true);
    expect(await fileLines(path)).toHaveLength(0);
    const fresh = database.connect();
    try {
      const input = { invocationId, toolId, args };
      const first = await executeNonTransactionalInvocation(fresh, ctx, input, {
        execute: (binding) => appendFileEffect(path, binding),
      });
      expect(first.status).toBe('ok');
      const next = await executeNonTransactionalInvocation(
        fresh,
        { ...ctx, requestId: randomUUID() },
        input,
        { execute: (binding) => appendFileEffect(path, binding) },
      );
      expect(next).toEqual({ ...first, replayed: true });
      expect(await fileLines(path)).toHaveLength(1);
    } finally {
      await fresh.end();
    }
  });

  it('revocation during an actual effect hides the response without losing its accepted fact or requiring reconciliation', async () => {
    const ctx = await seedContext(database.pool);
    const { invocationId } = await reserveInvocation(database.pool, ctx, {
      callKey: 'revoked-during-effect',
      toolId,
      args,
      executionKind: 'non_transactional',
    });
    const input = { invocationId, toolId, args };
    const path = join(directory, 'revoked.jsonl');
    const hidden = await executeNonTransactionalInvocation(database.pool, ctx, input, {
      execute: async (binding) => {
        const evidence = await appendFileEffect(path, binding);
        ctx.allowlist = [];
        return evidence;
      },
    });
    expect(hidden.status).toBe('denied');
    expect('result' in hidden).toBe(false);
    const fresh = database.connect();
    try {
      const forbidden = await executeNonTransactionalInvocation(fresh, ctx, input, {
        execute: (binding) => appendFileEffect(path, binding),
      });
      expect(forbidden.status).toBe('denied');
      ctx.allowlist = [toolId];
      const restored = await executeNonTransactionalInvocation(
        fresh,
        { ...ctx, requestId: randomUUID() },
        input,
        { execute: (binding) => appendFileEffect(path, binding) },
      );
      expect(restored).toMatchObject({
        status: 'ok',
        replayed: true,
        result: { kind: 'effect_evidence' },
      });
      expect(await fileLines(path)).toHaveLength(1);
    } finally {
      await fresh.end();
    }
  });

  it('SIGKILL after dispatch but before effect stays unknown with zero writes, including concurrent fresh-process submissions', async () => {
    const ctx = await seedContext(database.pool);
    const { invocationId } = await reserveInvocation(database.pool, ctx, {
      callKey: 'permission-death',
      toolId,
      args,
      executionKind: 'non_transactional',
    });
    const path = join(directory, 'permitted.jsonl');
    await runChild(database, ctx, invocationId, path, 'permitted', true);
    const pools = [database.connect(), database.connect()];
    try {
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          executeNonTransactionalInvocation(
            pools[index % 2]!,
            { ...ctx, requestId: randomUUID() },
            { invocationId, toolId, args },
            {
              execute: (binding) => appendFileEffect(path, binding),
              reconcile: (binding) => reconcileFileEffect(path, binding),
            },
          ),
        ),
      );
      expect(
        outcomes.every(
          (outcome) => outcome.status === 'unknown' && outcome.error.code === 'TOOL_EFFECT_UNKNOWN',
        ),
      ).toBe(true);
      expect(await fileLines(path)).toHaveLength(0);
      expect(
        (
          await database.pool.query(
            'SELECT state,accepted_result FROM tool_invocations WHERE invocation_id=$1',
            [invocationId],
          )
        ).rows[0],
      ).toEqual({ state: 'unknown', accepted_result: null });
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  });

  it('SIGKILL after append+fsync leaves one effect; retries cannot write and only bound read-only evidence completes', async () => {
    const ctx = await seedContext(database.pool);
    const { invocationId } = await reserveInvocation(database.pool, ctx, {
      callKey: 'effect-death',
      toolId,
      args,
      executionKind: 'non_transactional',
    });
    const path = join(directory, 'effected.jsonl');
    await runChild(database, ctx, invocationId, path, 'effected', true);
    const before = await fileLines(path);
    expect(before).toHaveLength(1);
    const fresh = database.connect();
    try {
      const input = { invocationId, toolId, args };
      const resubmissions = await Promise.all(
        Array.from({ length: 5 }, () =>
          executeNonTransactionalInvocation(fresh, { ...ctx, requestId: randomUUID() }, input, {
            execute: (binding) => appendFileEffect(path, binding),
          }),
        ),
      );
      expect(resubmissions.every((outcome) => outcome.status === 'unknown')).toBe(true);
      expect(await fileLines(path)).toEqual(before);
      await expect(
        executeNonTransactionalInvocation(fresh, ctx, input, {
          execute: (binding) => appendFileEffect(path, binding),
          reconcile: async (binding) => {
            const evidence = await reconcileFileEffect(path, binding);
            if (!evidence) throw new Error('expected actual file evidence');
            return { ...evidence, argsHash: '0'.repeat(64) };
          },
        }),
      ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
      const completed = await executeNonTransactionalInvocation(fresh, ctx, input, {
        execute: (binding) => appendFileEffect(path, binding),
        reconcile: (binding) => reconcileFileEffect(path, binding),
      });
      expect(completed.status).toBe('ok');
      const replay = await executeNonTransactionalInvocation(fresh, ctx, input, {
        execute: (binding) => appendFileEffect(path, binding),
      });
      expect(replay).toEqual({ ...completed, replayed: true });
      expect(await fileLines(path)).toEqual(before);
      expect(
        (
          await fresh.query(
            'SELECT state,evidence_ref FROM tool_invocations WHERE invocation_id=$1',
            [invocationId],
          )
        ).rows[0],
      ).toMatchObject({ state: 'completed', evidence_ref: expect.stringContaining(invocationId) });
    } finally {
      await fresh.end();
    }
  });

  it('independent process accepts actual success, and a proven pre-write failure is durable without any write', async () => {
    for (const mode of ['success', 'not_applied'] as const) {
      const ctx = await seedContext(database.pool);
      const { invocationId } = await reserveInvocation(database.pool, ctx, {
        callKey: mode,
        toolId,
        args,
        executionKind: 'non_transactional',
      });
      const path = join(directory, `${mode}.jsonl`);
      await runChild(database, ctx, invocationId, path, mode, false);
      const outcome = await executeNonTransactionalInvocation(
        database.pool,
        ctx,
        { invocationId, toolId, args },
        { execute: (binding) => appendFileEffect(path, binding) },
      );
      expect(outcome.status).toBe(mode === 'success' ? 'ok' : 'failed');
      expect(outcome.replayed).toBe(true);
      expect(await fileLines(path)).toHaveLength(mode === 'success' ? 1 : 0);
    }
  });

  for (const failureMode of ['throw', 'return'] as const) {
    it(`local domain failure (${failureMode}) rolls back an actual approval then persists only sanitized failed and never executes again`, async () => {
      const ctx = await seedContext(database.pool);
      const input = { toolId: 'internal.local-probe', args: { secret: 'not-for-storage' } };
      const { invocationId } = await reserveInvocation(database.pool, ctx, {
        ...input,
        callKey: 'domain-failure',
        executionKind: 'local',
      });
      const invoke = () =>
        executeLocalInvocation(database.pool, ctx, { ...input, invocationId }, async (client) => {
          await createTaskApproval(client, {
            ownerId: ctx.ownerId,
            conversationId: ctx.conversationId,
            originalText: 'must roll back',
            wallTime: '2027-10-17 09:20',
            timezoneId: 'Asia/Shanghai',
            fold: 0,
            foldChoice: 'none',
            offsetSeconds: 28800,
            fireAtUtc: '2027-10-17T01:20:00Z',
            tzdbVersion: 'fixture-v1',
          });
          if (failureMode === 'return')
            return {
              status: 'failed',
              error: { code: 'TOOL_ERROR', message: 'secret exception stack not-for-storage' },
            };
          const error = new ToolExecutionError();
          error.message = 'secret exception stack not-for-storage';
          throw error;
        });
      const first = await invoke();
      expect(first.status).toBe('failed');
      const second = await invoke();
      expect(second).toEqual({ ...first, replayed: true });
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int AS count FROM approvals WHERE owner_id=$1',
            [ctx.ownerId],
          )
        ).rows[0]?.count,
      ).toBe(0);
      const persisted = await database.pool.query(
        'SELECT * FROM tool_invocations WHERE invocation_id=$1',
        [invocationId],
      );
      expect(JSON.stringify(persisted.rows)).not.toContain('not-for-storage');
      expect(JSON.stringify(persisted.rows)).not.toContain('secret exception');
      expect(
        (
          await database.pool.query(
            'SELECT record_kind,outcome_kind FROM tool_calls WHERE invocation_id=$1 ORDER BY created_at',
            [invocationId],
          )
        ).rows,
      ).toEqual([
        { record_kind: 'failed', outcome_kind: 'failed' },
        { record_kind: 'replayed', outcome_kind: 'failed' },
      ]);
    });
  }
});
