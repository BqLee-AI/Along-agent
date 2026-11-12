import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { Pool, PoolClient } from 'pg';
import type { ThreadEvent } from '@along/stream-protocol';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { createHarnessModelTransport } from '../../src/modules/conversations/harness-model.js';
import { executeRun, startConversationRun } from '../../src/modules/conversations/service.js';
import { listRunEvents } from '../../src/modules/conversations/repository.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { listen, sendModelSse } from '../helpers/harness-consumer.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
} from './setup.js';

const binaryPath = process.env.HARNESS_BINARY;
const maybe = databaseUrl && binaryPath ? describe : describe.skip;

maybe('harness stream authority at a concurrent deactivation', () => {
  let database: IntegrationDatabase;
  let modelServer: Server;
  let modelBase: string;

  beforeAll(async () => {
    database = await createIntegrationDatabase();
    // A controlled OpenAI SSE fixture exercises native authority and persistence;
    // it is not evidence of the production SDK or outbound-policy behavior.
    modelServer = createServer((_req, res) => {
      sendModelSse(res, {
        message: { content: 'private streamed answer', tool_calls: [] },
        usage: { total_tokens: 5 },
      });
    });
    modelBase = await listen(modelServer);
  });

  afterAll(async () => {
    if (modelServer) {
      const closed = once(modelServer, 'close');
      modelServer.closeAllConnections();
      modelServer.close();
      await closed;
    }
    await database?.close();
  });

  async function accept() {
    const ownerId = randomUUID();
    await database.pool.query(
      `INSERT INTO users (id, auth_email, display_name, timezone_id)
       VALUES ($1, $2, 'tester', 'Asia/Shanghai')`,
      [ownerId, `tester-${ownerId}@along.test`],
    );
    await admitTestUser(database.pool, ownerId);
    await configureTestModel(database.pool, ownerId, 'fixture-transport-only');
    const deps = {
      pool: database.pool,
      timeContext: loadTimeContext('fixture-v1'),
      harness: {
        binaryPath: binaryPath!,
        libraryPath: process.env.HARNESS_LIBRARY_PATH ?? '/app/harness/lib',
        maxIterations: 8,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({
          completionCap: 1024,
          model: 'fixture-transport-only',
        }),
        model: createHarnessModelTransport({
          baseUrl: `${modelBase}/v1`,
          model: 'fixture-transport-only',
        }),
      },
    };
    controlledModelDeps(deps);
    const result = await startConversationRun(
      deps,
      ownerId,
      randomUUID(),
      {
        execution: 'harness',
        raw_text: 'Please answer briefly.',
        confirmed_timezone: 'Asia/Shanghai',
        idempotency_key: randomUUID(),
      },
      null,
    );
    if (!result.context) throw new Error('expected executable harness Run');
    return { deps, context: result.context, ownerId };
  }

  // Interpose only after a real COMMIT has completed, not on SQL results or the
  // writer. This makes the historic commit/write gap deterministic. Monitoring
  // and revocation use the original pool and therefore independent connections.
  function afterCommits(pool: Pool, callback: () => Promise<void>): Pool {
    return new Proxy(pool, {
      get(target, property) {
        if (property === 'connect')
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, key) {
                if (key === 'query')
                  return async (...args: unknown[]) => {
                    const result = await Reflect.apply(connection.query, connection, args);
                    if (args[0] === 'COMMIT') await callback();
                    return result;
                  };
                const value = Reflect.get(connection, key, connection);
                return typeof value === 'function' ? value.bind(connection) : value;
              },
            }) as PoolClient;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  for (const kind of ['delta', 'failure'] as const) {
    it(`never discloses ${kind} after deactivation commits`, async () => {
      const { deps, context, ownerId } = await accept();
      const events: ThreadEvent[] = [];
      const afterRevocation: ThreadEvent[] = [];
      let revoked = false;
      let revocation: Promise<void> | undefined;
      let failureCommitSeen = false;
      const revoke = () =>
        (revocation ??= database.pool
          .query("UPDATE users SET status = 'disabled' WHERE id = $1", [ownerId])
          .then(() => {
            revoked = true;
          }));
      const monitored = afterCommits(database.pool, async () => {
        if (revocation) return;
        const stored = await listRunEvents(database.pool, ownerId, context.runId);
        if (kind === 'delta' && stored.some((event) => event.type === 'message.delta')) {
          await revoke();
        } else if (kind === 'failure' && stored.some((event) => event.type === 'thread.failed')) {
          // In the old path the first COMMIT stores the failure and the second
          // commits its read gate. Revoke precisely after that gate, before write.
          // If a corrected path has already sent under its lock, revoke at once.
          if (failureCommitSeen || events.some((event) => event.type === 'thread.failed'))
            await revoke();
          failureCommitSeen = true;
        }
      });
      await executeRun({ ...deps, pool: monitored }, context, async (event) => {
        if (kind === 'failure' && event.type === 'thread.started') throw new Error('socket error');
        if (
          (kind === 'delta' && event.type === 'message.delta') ||
          (kind === 'failure' && event.type === 'thread.failed')
        ) {
          // If the corrected implementation holds the owner lock through write,
          // the update may wait: do not await it inside the writer.
          void revoke();
        }
        events.push(event);
        if (revoked) afterRevocation.push(event);
        return true;
      });
      if (revocation) await revocation;
      expect(revoked).toBe(true);
      expect(afterRevocation).toEqual([]);
      const stored = await listRunEvents(database.pool, ownerId, context.runId);
      if (kind === 'delta') {
        expect(stored.some((event) => event.type === 'message.delta')).toBe(true);
      } else {
        expect(stored.filter((event) => event.type === 'thread.failed')).toHaveLength(1);
        const status = await database.pool.query(
          `SELECT r.status AS run_status, a.status AS attempt_status
           FROM agent_runs r JOIN run_attempts a ON a.run_id = r.id
           WHERE r.id = $1 AND a.id = $2`,
          [context.runId, context.attemptId],
        );
        expect(status.rows[0]).toEqual({ run_status: 'failed', attempt_status: 'failed' });
      }
    }, 30_000);
  }
});
