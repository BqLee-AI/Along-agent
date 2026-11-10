import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { RunOwnership } from '../../src/modules/conversations/run-ownership.js';
import { withTransaction } from '../../src/db/transaction.js';
import { lockRun } from '../../src/modules/conversations/repository.js';
import {
  executeNonTransactionalInvocation,
  reserveInvocation,
} from '../../src/modules/tools/invocations.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';
import { seedContext, fileLines } from './tool-invocations-probe.js';
import { appendFileEffect } from './tool-invocations-file-effect.js';
import { createRunDriver, type RunDriver } from '../../src/modules/conversations/run-driver.js';

const maybe = databaseUrl ? describe : describe.skip;

maybe('Run ownership PostgreSQL session', () => {
  let database: IntegrationDatabase;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });

  it('excludes another owner and fences the wrong attempt token', async () => {
    const context = await seedContext(database.pool);
    const first = await RunOwnership.tryAcquire(database.pool, context.runId);
    expect(first).not.toBeNull();
    try {
      expect(await RunOwnership.tryAcquire(database.pool, context.runId)).toBeNull();
      await database.pool.query('UPDATE run_attempts SET lease_token=$1 WHERE id=$2', [
        first!.token,
        context.attemptId,
      ]);
      await first!.transaction((client) => first!.assert(client, context.runId, context.attemptId));
      await expect(
        first!.transaction((client) => first!.assert(client, context.runId, randomUUID())),
      ).rejects.toThrow();
      expect(first!.signal.aborted).toBe(true);
      await expect(first!.transaction(async () => undefined)).rejects.toThrow();
    } finally {
      await first!.close();
    }
    let successor: RunOwnership | null = null;
    const deadline = Date.now() + 3000;
    while (!successor && Date.now() < deadline) {
      successor = await RunOwnership.tryAcquire(database.pool, context.runId);
      if (!successor) await delay(50);
    }
    expect(successor).not.toBeNull();
    await successor!.close();
  });

  it('excludes a separate operating-system process until the owner releases', async () => {
    const runId = randomUUID();
    const owner = await RunOwnership.tryAcquire(database.pool, runId);
    expect(owner).not.toBeNull();
    const childSource = `
      import { Pool } from 'pg';
      import { RunOwnership } from './src/modules/conversations/run-ownership.ts';
      const pool = new Pool({ connectionString: process.env.OWNERSHIP_TEST_DATABASE });
      const owner = await RunOwnership.tryAcquire(pool, process.env.OWNERSHIP_TEST_RUN);
      console.log(owner ? 'acquired' : 'busy');
      await owner?.close();
      await pool.end();
    `;
    const probe = async () => {
      const child = Bun.spawn([process.execPath, '--no-env-file', '-e', childSource], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: {
          ...process.env,
          OWNERSHIP_TEST_DATABASE: database.connectionString,
          OWNERSHIP_TEST_RUN: runId,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`ownership child failed: ${stderr}`);
      return stdout.trim();
    };
    try {
      expect(await probe()).toBe('busy');
      await owner!.close();
      expect(await probe()).toBe('acquired');
    } finally {
      await owner!.close();
    }
  });

  it('fences the session after PostgreSQL destroys its backend', async () => {
    const context = await seedContext(database.pool);
    const owner = await RunOwnership.tryAcquire(database.pool, context.runId);
    expect(owner).not.toBeNull();
    try {
      await database.pool.query('UPDATE run_attempts SET lease_token=$1 WHERE id=$2', [
        owner!.token,
        context.attemptId,
      ]);
      const pid = await owner!.transaction(async (client) => {
        await owner!.assert(client, context.runId, context.attemptId);
        return (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      });
      await database.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      await expect(
        owner!.transaction((client) => owner!.assert(client, context.runId, context.attemptId)),
      ).rejects.toThrow();
      expect(owner!.signal.aborted).toBe(true);
    } finally {
      await owner!.close();
    }
  });
  it('requires the actual owning session for both Run and tool transactions', async () => {
    const original = await seedContext(database.pool);
    const runId = randomUUID();
    const attemptId = randomUUID();
    await database.pool.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,
         budget_max_iterations,budget_max_tokens,frozen_context)
       SELECT $2,owner_id,conversation_id,agent_revision,mode,
         budget_max_iterations,budget_max_tokens,
         jsonb_build_object('execution_lifecycle','server-owned')
       FROM agent_runs WHERE id=$1`,
      [original.runId, runId],
    );
    const context = { ...original, runId, attemptId };
    const owner = await RunOwnership.tryAcquire(database.pool, runId);
    expect(owner).not.toBeNull();
    const directory = await mkdtemp(join(tmpdir(), 'along-owned-effect-'));
    try {
      await database.pool.query(
        'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,lease_token) VALUES($1,$2,$3,1,$4)',
        [attemptId, context.ownerId, runId, owner!.token],
      );
      await expect(
        withTransaction(database.pool, (client) => lockRun(client, context)),
      ).rejects.toThrow();
      const reservation = {
        callKey: 'owned',
        toolId: 'internal.file-probe',
        args: { action: 'append-fsync' },
        executionKind: 'non_transactional' as const,
      };
      await expect(reserveInvocation(database.pool, context, reservation)).rejects.toThrow();
      await expect(
        withTransaction(database.pool, (client) =>
          lockRun(client, { ...context, ownership: owner! }),
        ),
      ).rejects.toThrow();
      await owner!.transaction((client) => lockRun(client, { ...context, ownership: owner! }));
      const reserved = await reserveInvocation(
        database.pool,
        { ...context, ownership: owner! },
        reservation,
      );
      expect(reserved.invocationId).toBeDefined();
      const path = join(directory, 'effect.jsonl');
      const outcome = await executeNonTransactionalInvocation(
        database.pool,
        { ...context, ownership: owner! },
        { invocationId: reserved.invocationId, toolId: reservation.toolId, args: reservation.args },
        {
          execute: async (binding) => {
            const evidence = await appendFileEffect(path, binding);
            await database.pool.query("UPDATE agent_runs SET status='cancelled' WHERE id=$1", [
              runId,
            ]);
            return evidence;
          },
        },
      );
      expect(outcome.status).toBe('denied');
      expect(await fileLines(path)).toHaveLength(1);
      expect(
        (
          await database.pool.query('SELECT state FROM tool_invocations WHERE invocation_id=$1', [
            reserved.invocationId,
          ])
        ).rows[0]?.state,
      ).toBe('completed');
      await expect(
        reserveInvocation(
          database.pool,
          { ...context, ownership: owner! },
          {
            ...reservation,
            callKey: 'after-stop',
          },
        ),
      ).rejects.toThrow();
    } finally {
      await owner!.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('checks the actual lock even without a connection-loss callback', async () => {
    const context = await seedContext(database.pool);
    const owner = await RunOwnership.tryAcquire(database.pool, context.runId);
    expect(owner).not.toBeNull();
    try {
      await database.pool.query('UPDATE run_attempts SET lease_token=$1 WHERE id=$2', [
        owner!.token,
        context.attemptId,
      ]);
      await expect(
        owner!.transaction(async (client) => {
          await client.query('SELECT pg_advisory_unlock_all()');
          await owner!.assert(client, context.runId, context.attemptId);
        }),
      ).rejects.toThrow();
      expect(owner!.signal.aborted).toBe(true);
    } finally {
      await owner!.close();
    }
  });

  it('fences a blackholed ownership session within the client query timeout', async () => {
    const source = new URL(database.connectionString);
    const target = { host: source.hostname, port: Number(source.port) };
    let blackholed = false;
    const proxy = createServer((inbound) => {
      const upstream = createConnection(target);
      inbound.on('data', (chunk) => {
        if (!blackholed) upstream.write(chunk);
      });
      upstream.on('data', (chunk) => {
        if (!blackholed) inbound.write(chunk);
      });
      inbound.on('close', () => upstream.destroy());
      upstream.on('close', () => inbound.destroy());
      inbound.on('error', () => upstream.destroy());
      upstream.on('error', () => inbound.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('missing proxy address');
    source.hostname = '127.0.0.1';
    source.port = String(address.port);
    const lockPool = new Pool({ connectionString: source.toString(), query_timeout: 300 });
    const runId = randomUUID();
    const owner = await RunOwnership.tryAcquire(lockPool, runId);
    try {
      expect(owner).not.toBeNull();
      blackholed = true;
      const started = Date.now();
      await expect(owner!.transaction((client) => owner!.assert(client, runId))).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3000);
      expect(owner!.signal.aborted).toBe(true);
      await expect(owner!.transaction(async () => undefined)).rejects.toThrow();
    } finally {
      await owner?.close();
      await lockPool.end();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
    let successor: RunOwnership | null = null;
    const deadline = Date.now() + 3000;
    while (!successor && Date.now() < deadline) {
      successor = await RunOwnership.tryAcquire(database.pool, runId);
      if (!successor) await delay(50);
    }
    expect(successor).not.toBeNull();
    await successor?.close();
  });

  it('permanently fences the owner on a SQL timeout', async () => {
    const context = await seedContext(database.pool);
    const owner = await RunOwnership.tryAcquire(database.pool, context.runId);
    expect(owner).not.toBeNull();
    try {
      await expect(
        owner!.transaction(async (client) => {
          await client.query("SET LOCAL statement_timeout='25ms'");
          await client.query('SELECT pg_sleep(1)');
        }),
      ).rejects.toThrow();
      expect(owner!.signal.aborted).toBe(true);
      await expect(owner!.transaction(async () => undefined)).rejects.toThrow();
    } finally {
      await owner!.close();
    }
  });

  it('only finalizes an orphan after its owning process crashes', async () => {
    const original = await seedContext(database.pool);
    const runId = randomUUID();
    const attemptId = randomUUID();
    await database.pool.query(
      `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,
         budget_max_iterations,budget_max_tokens,frozen_context)
       SELECT $2,owner_id,conversation_id,agent_revision,mode,
         budget_max_iterations,budget_max_tokens,
         jsonb_build_object('execution_lifecycle','server-owned')
       FROM agent_runs WHERE id=$1`,
      [original.runId, runId],
    );
    await database.pool.query(
      'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,1)',
      [attemptId, original.ownerId, runId],
    );
    const child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        `
      import { Pool } from 'pg';
      import { RunOwnership } from './src/modules/conversations/run-ownership.ts';
      const pool = new Pool({ connectionString: process.env.OWNERSHIP_TEST_DATABASE });
      const owner = await RunOwnership.tryAcquire(pool, process.env.OWNERSHIP_TEST_RUN);
      console.log(owner ? 'acquired' : 'busy');
      await new Promise(() => {});
    `,
      ],
      {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: {
          ...process.env,
          OWNERSHIP_TEST_DATABASE: database.connectionString,
          OWNERSHIP_TEST_RUN: runId,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    let driver: RunDriver | undefined;
    try {
      expect(new TextDecoder().decode((await child.stdout.getReader().read()).value).trim()).toBe(
        'acquired',
      );
      driver = createRunDriver(database.pool);
      await delay(2200);
      expect(
        (await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0]
          ?.status,
      ).toBe('running');
      child.kill('SIGKILL');
      await child.exited;
      let status = 'running';
      const deadline = Date.now() + 8000;
      while (status === 'running' && Date.now() < deadline) {
        await delay(100);
        status = (await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [runId]))
          .rows[0]?.status;
      }
      expect(status).toBe('failed');
      expect(
        (await database.pool.query('SELECT status FROM run_attempts WHERE id=$1', [attemptId]))
          .rows[0]?.status,
      ).toBe('fenced_out');
      expect(
        (
          await database.pool.query(
            `SELECT count(*)::int AS count FROM run_checkpoints
         WHERE attempt_id=$1 AND kind='thread.failed'`,
            [attemptId],
          )
        ).rows[0]?.count,
      ).toBe(1);
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int AS count FROM tool_invocations WHERE run_id=$1',
            [runId],
          )
        ).rows[0]?.count,
      ).toBe(0);
    } finally {
      child.kill('SIGKILL');
      await driver?.shutdown();
    }
  }, 15000);
});
