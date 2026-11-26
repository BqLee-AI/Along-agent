import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { ToolContext, ToolOutcome, ToolResult } from '../../src/agent/tools/contracts.js';
import {
  executeLocalInvocation,
  executeNonTransactionalInvocation,
  reserveInvocation,
} from '../../src/agent/tools/invocations/invocations.js';
import {
  createPersonalBot,
  updatePersonalBot,
  type PersonalBot,
} from '../../src/features/bots/public.js';
import { createBotConversation } from '../../src/features/conversations/public.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';
import { appendFileEffect, reconcileFileEffect } from './tool-invocations-file-effect.js';

const maybe = databaseUrl ? describe : describe.skip;
const toolId = 'list_tasks';
const args = {};
const config = {
  name: 'Effect race',
  introduction: '',
  role: '',
  instructions: '',
  model_selection: null,
  tool_ids: [toolId],
  workspace_ids: [],
};
const narrowed = { ...config, tool_ids: [] };

async function backendPid(client: PoolClient) {
  return (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
}

async function waitBlockedBy(pool: Pool, pid: number) {
  for (let i = 0; i < 200; i++) {
    const { rows } = await pool.query(
      'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) LIMIT 1',
      [pid],
    );
    if (rows.length) return;
    await pool.query('SELECT pg_sleep(0.01)');
  }
  throw new Error('the competing transaction did not wait for the Bot row lock');
}

maybe('live Bot authority at durable effect boundaries', () => {
  let database: IntegrationDatabase;

  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });

  async function fixture(executionKind: 'local' | 'non_transactional') {
    const { pool } = database;
    const { userId: ownerId, sessionId } = await seedAdmittedSession(pool);
    const actor = { ownerId, sessionId, displayName: 'Seed User', timezoneId: 'Asia/Shanghai' };
    const bot = await createPersonalBot(pool, actor, config);
    const { conversation_id: conversationId } = await createBotConversation(
      pool,
      actor,
      bot.id,
      randomUUID(),
    );
    const runId = randomUUID();
    const attemptId = randomUUID();
    await pool.query(
      `INSERT INTO agent_runs (id, owner_id, conversation_id, agent_revision, mode,
        budget_max_iterations, budget_max_tokens, tools_allowlist, frozen_context)
       VALUES ($1,$2,$3,'effect-probe','chat',1,100,$4::jsonb,$5)`,
      [
        runId,
        ownerId,
        conversationId,
        JSON.stringify([toolId]),
        {
          personalBot: {
            id: bot.id,
            revision: bot.revision,
            role: config.role,
            instructions: config.instructions,
          },
        },
      ],
    );
    await pool.query(
      'INSERT INTO run_attempts (id, owner_id, run_id, attempt_no) VALUES ($1,$2,$3,1)',
      [attemptId, ownerId, runId],
    );
    const ctx: ToolContext = {
      ownerId,
      conversationId,
      runId,
      attemptId,
      requestId: randomUUID(),
      allowlist: [toolId],
      confirmedTimezone: 'Asia/Shanghai',
      anchorReceivedAtUtc: '2026-10-17T00:00:00Z',
      receivedAtUtc: '2026-10-17T00:00:00Z',
      foldChoice: 'none',
      timeContext: loadTimeContext('fixture-v1'),
    };
    const { invocationId } = await reserveInvocation(pool, ctx, {
      callKey: 'effect-race',
      toolId,
      args,
      executionKind,
    });
    return { pool, actor, bot, ctx, input: { invocationId, toolId, args } };
  }

  it('waits for a concurrent narrowing to commit before deciding a new external permit', async () => {
    const { pool, bot, ctx, input } = await fixture('non_transactional');
    const writer = await pool.connect();
    let execution: Promise<ToolOutcome> | undefined;
    let dispatched = false;
    try {
      const pid = await backendPid(writer);
      await writer.query('BEGIN');
      await writer.query('UPDATE personal_bots SET revision=revision+1, config=$2 WHERE id=$1', [
        bot.id,
        narrowed,
      ]);
      execution = executeNonTransactionalInvocation(pool, ctx, input, {
        execute: async (binding) => {
          dispatched = true;
          return { ...binding, evidenceRef: 'unexpected-dispatch', notApplied: true };
        },
      });
      await Promise.race([
        waitBlockedBy(pool, pid),
        execution.then(() => {
          throw new Error('permit resolved while Bot narrowing was uncommitted');
        }),
      ]);
      await writer.query('COMMIT');
      const outcome = await execution;
      expect(outcome.status).toBe('denied');
      expect('result' in outcome).toBe(false);
      expect(dispatched).toBe(false);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      await execution?.catch(() => {});
    }
  });

  it('holds Bot authority through a transactional effect and hides the replay after narrowing', async () => {
    const { pool, actor, bot, ctx, input } = await fixture('local');
    const reached = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const result = {
      status: 'ok',
      result: { kind: 'effect_evidence', evidence_ref: 'local-effect' },
    } satisfies ToolResult;
    const execution = executeLocalInvocation(pool, ctx, input, async (client) => {
      await client.query("UPDATE conversations SET title='Local effect' WHERE id=$1", [
        ctx.conversationId,
      ]);
      reached.resolve(await backendPid(client));
      await release.promise;
      return result;
    });
    let narrowing: Promise<PersonalBot> | undefined;
    try {
      const pid = await Promise.race([
        reached.promise,
        execution.then(() => {
          throw new Error('effect never reached its transaction');
        }),
      ]);
      narrowing = updatePersonalBot(pool, actor, bot.id, bot.revision, narrowed);
      await Promise.race([
        waitBlockedBy(pool, pid),
        narrowing.then(() => {
          throw new Error('Bot narrowing committed before the local effect');
        }),
      ]);
      release.resolve();
      expect(await execution).toMatchObject({ ...result, replayed: false });
      await narrowing;
      expect(
        (await pool.query('SELECT title FROM conversations WHERE id=$1', [ctx.conversationId]))
          .rows[0],
      ).toEqual({ title: 'Local effect' });
      const replay = await executeLocalInvocation(pool, ctx, input, async () => {
        throw new Error('accepted effect executed again');
      });
      expect(replay.status).toBe('denied');
      expect('result' in replay).toBe(false);
    } finally {
      release.resolve();
      await execution.catch(() => {});
      await narrowing?.catch(() => {});
    }
  });

  it.each(['returned evidence', 'unknown effect'] as const)(
    'accounts for a licensed effect after narrowing: %s',
    async (disposition) => {
      const { pool, actor, bot, ctx, input } = await fixture('non_transactional');
      const directory = await mkdtemp(join(tmpdir(), 'along-bot-effect-'));
      const path = join(directory, 'effect.jsonl');
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const writer = await pool.connect();
      const execution = executeNonTransactionalInvocation(pool, ctx, input, {
        execute: async (binding) => {
          reached.resolve();
          await release.promise;
          const evidence = await appendFileEffect(path, binding);
          if (disposition === 'unknown effect') throw new Error('external result was lost');
          return evidence;
        },
      });
      try {
        await Promise.race([
          reached.promise,
          execution.then(() => {
            throw new Error('the reserved effect never received its permit');
          }),
        ]);
        // Fail rather than stall if an invocation holds the Bot lock across I/O.
        await writer.query('BEGIN');
        await writer.query("SET LOCAL lock_timeout = '1s'");
        await writer.query('UPDATE personal_bots SET revision=revision+1, config=$2 WHERE id=$1', [
          bot.id,
          narrowed,
        ]);
        await writer.query('COMMIT');
        release.resolve();
        const outcome = await execution;
        expect(outcome.status).toBe(disposition === 'returned evidence' ? 'denied' : 'unknown');
        expect('result' in outcome).toBe(false);
        const replay = () =>
          executeNonTransactionalInvocation(pool, ctx, input, {
            execute: (binding) => appendFileEffect(path, binding),
          });
        if (disposition === 'unknown effect') {
          const reconciled = await executeNonTransactionalInvocation(pool, ctx, input, {
            execute: (binding) => appendFileEffect(path, binding),
            reconcile: (binding) => reconcileFileEffect(path, binding),
          });
          expect('result' in reconciled).toBe(false);
        }
        expect((await replay()).status).toBe('denied');
        await updatePersonalBot(pool, actor, bot.id, bot.revision + 1, config);
        expect(await replay()).toMatchObject({
          status: 'ok',
          replayed: true,
          result: { kind: 'effect_evidence' },
        });
        expect((await readFile(path, 'utf8')).trimEnd().split('\n')).toHaveLength(1);
      } finally {
        await writer.query('ROLLBACK');
        writer.release();
        release.resolve();
        await execution.catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
