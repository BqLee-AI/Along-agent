import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { createHarnessModelTransport } from '../../src/modules/conversations/harness-model.js';
import { createRunDriver } from '../../src/modules/conversations/run-driver.js';
import { handleConversationRoute } from '../../src/modules/conversations/routes.js';
import { ThreadEventSchema } from '@along/stream-protocol';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { listen, sendModelSse } from '../helpers/harness-consumer.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const binaryPath = process.env.HARNESS_BINARY;
const maybe = databaseUrl && binaryPath ? describe : describe.skip;

maybe('server-owned native execution', () => {
  let database: IntegrationDatabase;
  let server: Server;
  let base: string;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let modelCalls = 0;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    server = createServer((_req, res) => {
      modelCalls++;
      entered.resolve();
      void release.promise.then(() =>
        sendModelSse(res, {
          message: {
            content: null,
            tool_calls: [
              {
                id: randomUUID(),
                type: 'function',
                function: {
                  name: 'finish_goal',
                  arguments: JSON.stringify({
                    status: 'completed',
                    outcomes: [{ description: '回答', status: 'achieved', receipt_refs: [] }],
                    clarification: null,
                    answer: '完成',
                  }),
                },
              },
            ],
          },
          usage: { total_tokens: 5 },
        }),
      );
    });
    base = await listen(server);
  });
  afterAll(async () => {
    release.resolve();
    if (server) {
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
    }
    await database?.close();
  });
  it('continues after an HTTP subscriber disconnects and replays without executing again', async () => {
    const session = await seedAdmittedSession(database.pool);
    const ownerId = session.userId;
    let sessionId = session.sessionId;
    const driver = createRunDriver(database.pool);
    let api: Server | undefined;
    try {
      const deps = {
        pool: database.pool,
        timeContext: loadTimeContext('fixture-v1'),
        runDriver: driver,
        harness: {
          binaryPath: binaryPath!,
          libraryPath: process.env.HARNESS_LIBRARY_PATH!,
          maxIterations: 8,
          maxTokens: 8000,
          contextPolicy: createContextPolicy({
            completionCap: 1024,
            model: 'fixture-transport-only',
          }),
          model: createHarnessModelTransport({
            baseUrl: `${base}/v1`,
            model: 'fixture-transport-only',
          }),
        },
      };
      api = createServer((req, res) => {
        void handleConversationRoute(req, res, new URL(req.url ?? '/', 'http://localhost'), {
          ...deps,
          resolveActor: async () => ({
            ownerId,
            sessionId,
            displayName: 'tester',
            timezoneId: 'Asia/Shanghai',
          }),
        });
      });
      const apiBase = await listen(api);
      const started = await startConversationRun(
        deps,
        ownerId,
        randomUUID(),
        {
          execution: 'harness',
          authorization_revision: 'delegation/1',
          raw_text: '请回答。',
        },
        randomUUID(),
      );
      expect(started.serverOwned).toBe(true);
      await entered.promise;
      const path = `${apiBase}/api/v1/conversations/${started.conversationId}/runs/${started.runId}/events`;
      const abort = new AbortController();
      const subscription = await fetch(path, { signal: abort.signal });
      expect(subscription.status).toBe(200);
      const first = await subscription.body!.getReader().read();
      expect(first.done).toBe(false);
      abort.abort();
      await database.pool.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1', [
        sessionId,
      ]);
      expect(
        (await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [started.runId]))
          .rows[0]?.status,
      ).toBe('running');
      release.resolve();
      let status = 'running';
      const deadline = Date.now() + 15000;
      while (status === 'running' && Date.now() < deadline) {
        await delay(100);
        status = (
          await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [started.runId])
        ).rows[0]?.status;
      }
      expect(status).toBe('done');
      expect(modelCalls).toBe(1);
      const replacement = await database.pool.query<{ id: string }>(
        `INSERT INTO sessions(user_id,token_hash,expires_at,client_info)
         VALUES($1,$2,now()+interval '1 day','{}') RETURNING id`,
        [ownerId, randomUUID()],
      );
      sessionId = replacement.rows[0]!.id;
      expect(
        (
          await database.pool.query('SELECT count(*)::int AS n FROM run_attempts WHERE run_id=$1', [
            started.runId,
          ])
        ).rows[0]?.n,
      ).toBe(1);
      const replay = await fetch(path);
      expect(replay.status).toBe(200);
      const events = (await replay.text())
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: '))
        .map((frame) => ThreadEventSchema.parse(JSON.parse(frame.slice(6))));
      expect(events.at(-1)?.type).toBe('thread.completed');
      expect(modelCalls).toBe(1);
    } finally {
      release.resolve();
      if (api) {
        const closed = once(api, 'close');
        api.closeAllConnections();
        api.close();
        await closed;
      }
      await driver.shutdown();
    }
  }, 30000);
  for (const mode of ['stop', 'disable'] as const) {
    it(`${mode} from another process revokes the running native attempt`, async () => {
      const ownerId = randomUUID();
      await database.pool.query(
        "INSERT INTO users(id,auth_email,display_name) VALUES($1,$2,'tester')",
        [ownerId, `${ownerId}@along.test`],
      );
      await admitTestUser(database.pool, ownerId);
      const received = Promise.withResolvers<void>();
      const disconnected = Promise.withResolvers<void>();
      const heldModel = createServer((_req, res) => {
        res.on('close', () => disconnected.resolve());
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': waiting\n\n', () => received.resolve());
      });
      const modelBase = await listen(heldModel);
      const driver = createRunDriver(database.pool);
      const transport = createHarnessModelTransport({
        baseUrl: `${modelBase}/v1`,
        model: 'fixture-transport-only',
      });
      const modelAborted = Promise.withResolvers<void>();
      try {
        const deps = {
          pool: database.pool,
          timeContext: loadTimeContext('fixture-v1'),
          runDriver: driver,
          harness: {
            binaryPath: binaryPath!,
            libraryPath: process.env.HARNESS_LIBRARY_PATH!,
            maxIterations: 8,
            maxTokens: 8000,
            contextPolicy: createContextPolicy({
              completionCap: 1024,
              model: 'fixture-transport-only',
            }),
            model: (
              request: Parameters<typeof transport>[0],
              tools: Parameters<typeof transport>[1],
              signal: AbortSignal,
            ) => {
              signal.addEventListener('abort', () => modelAborted.resolve(), { once: true });
              return transport(request, tools, signal);
            },
          },
        };
        const started = await startConversationRun(
          deps,
          ownerId,
          randomUUID(),
          {
            execution: 'harness',
            authorization_revision: 'delegation/1',
            raw_text: '请回答。',
          },
          randomUUID(),
        );
        await received.promise;
        const childSource = `
        import { Pool } from 'pg';
        import { cancelConversationRun } from './src/modules/conversations/service.ts';
        import { loadTimeContext } from './src/modules/time/context.ts';
        import { randomUUID } from 'node:crypto';
        const pool = new Pool({ connectionString: process.env.OWNERSHIP_TEST_DATABASE });
        if (process.env.OWNERSHIP_TEST_MODE === 'disable') {
          await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [process.env.OWNERSHIP_TEST_OWNER]);
          console.log('disabled');
        } else {
          const result = await cancelConversationRun({ pool, timeContext: loadTimeContext('fixture-v1') },
            process.env.OWNERSHIP_TEST_OWNER, process.env.OWNERSHIP_TEST_CONVERSATION,
            process.env.OWNERSHIP_TEST_RUN, randomUUID(), { idempotency_key: randomUUID() });
          console.log(result.status);
        }
        await pool.end();
      `;
        const child = Bun.spawn([process.execPath, '--no-env-file', '-e', childSource], {
          cwd: fileURLToPath(new URL('../..', import.meta.url)),
          env: {
            ...process.env,
            OWNERSHIP_TEST_DATABASE: database.connectionString,
            OWNERSHIP_TEST_OWNER: ownerId,
            OWNERSHIP_TEST_CONVERSATION: started.conversationId,
            OWNERSHIP_TEST_MODE: mode,
            OWNERSHIP_TEST_RUN: started.runId,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (code !== 0) throw new Error(`stop process failed: ${stderr}`);
        expect(stdout.trim()).toBe(mode === 'stop' ? 'cancelled' : 'disabled');
        await Promise.race([
          modelAborted.promise,
          delay(3000).then(() => {
            throw new Error('model signal not aborted');
          }),
        ]);
        await Promise.race([
          disconnected.promise,
          delay(5000).then(() => {
            throw new Error('provider did not abort');
          }),
        ]);
        let status = 'running';
        const deadline = Date.now() + 8000;
        while (status === 'running' && Date.now() < deadline) {
          await delay(100);
          status = (
            await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [started.runId])
          ).rows[0]?.status;
        }
        expect(status).toBe(mode === 'stop' ? 'cancelled' : 'failed');
        expect(
          (
            await database.pool.query(
              `SELECT count(*)::int AS n FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
         WHERE a.run_id=$1 AND c.kind=$2`,
              [started.runId, mode === 'stop' ? 'thread.cancelled' : 'thread.failed'],
            )
          ).rows[0]?.n,
        ).toBe(1);
        expect(
          (
            await database.pool.query(
              'SELECT count(*)::int AS n FROM run_attempts WHERE run_id=$1',
              [started.runId],
            )
          ).rows[0]?.n,
        ).toBe(1);
      } finally {
        await driver.shutdown();
        const closed = once(heldModel, 'close');
        heldModel.closeAllConnections();
        heldModel.close();
        await closed;
      }
    }, 30000);
  }
});
