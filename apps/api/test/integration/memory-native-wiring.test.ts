import { createFixtureConversation } from '../helpers/bot-conversation.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import type { HarnessRequest } from '@along/contracts';
import { handleRequest } from '../helpers/http-app.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { measureSdkContext } from '../../src/features/model-providers/public.js';
import { createLocalFixtureModelTransport } from '../helpers/local-fixture-model.js';
import { configureTestModel } from '../helpers/model-selection.js';
import {
  findModelObservation,
  frames,
  jsonBody,
  listen,
  sendModelSse,
} from '../helpers/harness-consumer.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl && process.env.HARNESS_BINARY ? describe : describe.skip;
const observation = z.object({
  invocation_id: z.string().uuid(),
  result: z.object({
    status: z.literal('ok'),
    result: z.object({ kind: z.enum(['memory_saved', 'memory_recall']) }).passthrough(),
  }),
});

maybe('cross-session memory through native harness', () => {
  let database: IntegrationDatabase;
  let api: Server;
  let provider: Server;
  let base: string;
  const seen: unknown[] = [];
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    provider = createServer((req, res) => {
      void (async () => {
        const body = (await jsonBody(req)) as {
          messages: Extract<HarnessRequest, { type: 'model' }>['messages'];
        };
        const result = findModelObservation(body.messages, observation);
        if (result) seen.push(result.result.result);
        const current =
          body.messages.findLast(
            (item) => item.role === 'user' && item.content.includes('memory-case:'),
          )?.content ?? '';
        const tool = current.includes('save') ? 'remember_memory' : 'recall_memories';
        const args =
          tool === 'remember_memory' ? { content: '编号 XQ-4792' } : { query: 'XQ-4792' };
        const call = result
          ? {
              name: 'finish_goal',
              arguments: JSON.stringify({
                status: 'completed',
                outcomes: [
                  {
                    description: '记忆操作',
                    status: 'achieved',
                    receipt_refs: [result.invocation_id],
                  },
                ],
                clarification: null,
                answer: '完成',
              }),
            }
          : { name: tool, arguments: JSON.stringify(args) };
        sendModelSse(res, {
          message: {
            content: null,
            tool_calls: [{ id: `test-${randomUUID()}`, type: 'function', function: call }],
          },
          usage: { total_tokens: 5 },
        });
      })().catch(() => {
        res.destroy();
      });
    });
    const modelBase = await listen(provider);
    const model = createLocalFixtureModelTransport({
      baseUrl: `${modelBase}/v1`,
      model: 'fixture-transport-only',
    });
    api = createServer((req, res) => {
      void handleRequest(req, res, {
        pool: database.pool,
        tzdbVersion: 'fixture-v1',
        harness: {
          binaryPath: process.env.HARNESS_BINARY!,
          libraryPath: process.env.HARNESS_LIBRARY_PATH,
          maxIterations: 8,
          maxTokens: 8000,
          contextPolicy: createContextPolicy({
            completionCap: 1024,
            model: 'fixture-transport-only',
          }),
        },
        modelTransport: async () => ({ model, measure: measureSdkContext }),
      });
    });
    base = await listen(api);
  });
  afterAll(async () => {
    for (const server of [api, provider]) {
      if (!server) continue;
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
    }
    await database?.close();
  });
  it('saves explicit input and recalls only the same owner in a new conversation', async () => {
    const owner = await seedAdmittedSession(database.pool);
    const foreign = await seedAdmittedSession(database.pool);
    for (const actor of [owner, foreign])
      await configureTestModel(database.pool, actor.userId, 'fixture-transport-only');
    async function run(actor: typeof owner, text: string) {
      const response = await fetch(`${base}/api/v1/conversations/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `better-auth.session_token=${actor.token}`,
          'x-csrf-token': actor.csrfToken,
        },
        body: JSON.stringify({
          conversation_id: await createFixtureConversation(database.pool, actor.userId),
          execution: 'harness',
          authorization_revision: 'delegation/1',
          raw_text: text,
          idempotency_key: randomUUID(),
        }),
      });
      expect(response.status).toBe(200);
      const events = frames(await response.text());
      expect(events.find((event) => event.type === 'thread.failed')).toBeUndefined();
    }
    await run(owner, 'memory-case:save 请记住编号 XQ-4792');
    await run(owner, 'memory-case:recall 我之前的编号是什么？');
    await run(foreign, 'memory-case:recall 我之前的编号是什么？');
    expect(seen[0]).toMatchObject({ kind: 'memory_saved', content: '编号 XQ-4792' });
    expect(seen[1]).toMatchObject({
      kind: 'memory_recall',
      completeness: 'degraded',
      items: [{ content: '编号 XQ-4792' }],
    });
    expect(seen[2]).toMatchObject({ kind: 'memory_recall', completeness: 'degraded', items: [] });
    const rows = await database.pool.query(
      'SELECT count(*)::int AS count FROM r3_memories WHERE owner_id=$1',
      [owner.userId],
    );
    expect(rows.rows[0].count).toBe(1);
  }, 30000);

  it('recalls a manually saved memory in a new native conversation', async () => {
    const owner = await seedAdmittedSession(database.pool);
    await configureTestModel(database.pool, owner.userId, 'fixture-transport-only');
    const headers = {
      'content-type': 'application/json',
      cookie: `better-auth.session_token=${owner.token}`,
      'x-csrf-token': owner.csrfToken,
    };
    const saved = await fetch(`${base}/api/v1/memories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        category: 'project',
        content: '手动记录的项目编号 XQ-4792',
        idempotencyKey: randomUUID(),
      }),
    });
    expect(saved.ok).toBe(true);
    const before = seen.length;
    const response = await fetch(`${base}/api/v1/conversations/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        conversation_id: await createFixtureConversation(database.pool, owner.userId),
        execution: 'harness',
        authorization_revision: 'delegation/1',
        raw_text: 'memory-case:recall 我的项目编号是什么？',
        idempotency_key: randomUUID(),
      }),
    });
    expect(response.status).toBe(200);
    expect(
      frames(await response.text()).find((event) => event.type === 'thread.failed'),
    ).toBeUndefined();
    expect(seen[before]).toMatchObject({
      kind: 'memory_recall',
      items: [
        {
          content: '手动记录的项目编号 XQ-4792',
          conversation_id: null,
          message_ids: [],
        },
      ],
    });
  }, 30000);
});
