import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { ConversationMessagePageSchema, SkillDetailSchema } from '@along/contracts';
import { z } from 'zod';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { measureSdkContext } from '../../src/features/model-providers/public.js';
import { createApp } from '../../src/http/app.js';
import { fixtureBotConfig } from '../helpers/bot-conversation.js';
import { frames, jsonBody, listen, sendModelSse } from '../helpers/harness-consumer.js';
import { createLocalFixtureModelTransport } from '../helpers/local-fixture-model.js';
import { configureTestModel } from '../helpers/model-selection.js';
import { createIntegrationDatabase, databaseUrl, seedAdmittedSession } from './setup.js';

const maybe = databaseUrl && process.env.HARNESS_BINARY ? describe : describe.skip;
const modelId = 'fixture-transport-only';
const firstBody = 'first-skill-body-marker';
const secondBody = 'second-skill-body-marker';

maybe('personal skills through native Harness and model transport', () => {
  let db: Awaited<ReturnType<typeof createIntegrationDatabase>>;
  let owner: Awaited<ReturnType<typeof seedAdmittedSession>>;
  let provider: Server;
  let request: (method: string, path: string, body?: unknown, key?: string) => Promise<Response>;
  const received: {
    messages: { role: string; content: string }[];
    tools: { function: { name: string } }[];
  }[] = [];
  let beforeModel: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    db = await createIntegrationDatabase();
    owner = await seedAdmittedSession(db.pool);
    await configureTestModel(db.pool, owner.userId, modelId);
    provider = createServer((req, res) => {
      void (async () => {
        received.push((await jsonBody(req)) as (typeof received)[number]);
        sendModelSse(res, {
          message: {
            content: null,
            tool_calls: [
              {
                id: `finish-${randomUUID()}`,
                type: 'function',
                function: {
                  name: 'finish_goal',
                  arguments: JSON.stringify({
                    status: 'completed',
                    outcomes: [{ description: '整理周报', status: 'achieved', receipt_refs: [] }],
                    clarification: null,
                    answer: '完成',
                  }),
                },
              },
            ],
          },
          usage: { total_tokens: 5 },
        });
      })().catch(() => res.destroy());
    });
    const upstream = createLocalFixtureModelTransport({
      baseUrl: `${await listen(provider)}/v1`,
      model: modelId,
    });
    const app = createApp({
      pool: db.pool,
      tzdbVersion: 'fixture-v1',
      harness: {
        binaryPath: process.env.HARNESS_BINARY!,
        libraryPath: process.env.HARNESS_LIBRARY_PATH,
        maxIterations: 8,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({ completionCap: 1024, model: modelId }),
      },
      modelTransport: async () => ({
        measure: measureSdkContext,
        model: async function* (...args: Parameters<typeof upstream>) {
          const hook = beforeModel;
          beforeModel = undefined;
          await hook?.();
          yield* upstream(...args);
        },
      }),
    });
    request = (method, path, body, key) =>
      app.handle(
        new Request(`http://localhost/api/v1${path}`, {
          method,
          headers: {
            cookie: `better-auth.session_token=${owner.token}`,
            'x-csrf-token': owner.csrfToken,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(key ? { 'Idempotency-Key': key } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
  });

  afterAll(async () => {
    if (provider) {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
    await db?.close();
  });

  it('freezes selection and history, and enforces live revocation at actual dispatch', async () => {
    const createInput = { name: 'weekly-report', description: '写周报', body: firstBody };
    const created = await request('POST', '/skills', createInput, randomUUID());
    expect(created.ok).toBe(true);
    const { data: initial } = z.object({ data: SkillDetailSchema }).parse(await created.json());
    const config = { ...fixtureBotConfig(owner.userId), tool_ids: [], skill_ids: [initial.id] };
    const { data: bot } = z
      .object({ data: z.object({ id: z.string() }) })
      .parse(await (await request('POST', '/bots', config)).json());
    const botSkills = await request('GET', `/bots/${bot.id}/skills`);
    expect(await botSkills.json()).toMatchObject({
      data: { items: [{ id: initial.id, revision: 1 }] },
    });
    const { data: conversation } = z
      .object({ data: z.object({ conversation_id: z.string() }) })
      .parse(
        await (await request('POST', `/bots/${bot.id}/conversations`, {}, randomUUID())).json(),
      );
    const sequence = {
      ...conversation,
      raw_text: '整理周报',
      execution: 'harness',
      authorization_revision: 'delegation/1',
      skill: { id: initial.id, revision: 1 },
    };
    const key = randomUUID();
    const first = await request('POST', '/conversations/messages', sequence, key);
    expect(first.ok).toBe(true);
    expect(frames(await first.text()).filter((event) => event.type === 'thread.failed')).toEqual(
      [],
    );
    expect(JSON.stringify(received.at(-1)?.messages)).toContain(firstBody);
    expect(received.at(-1)?.tools.map((tool) => tool.function.name)).not.toContain(
      'create_reminder',
    );

    const updated = await request('PATCH', `/skills/${initial.id}`, {
      ...createInput,
      body: secondBody,
      expected_revision: 1,
    });
    expect(updated.ok).toBe(true);
    const sendCount = received.length;
    const replay = await request('POST', '/conversations/messages', sequence, key);
    expect(replay.ok).toBe(true);
    await replay.text();
    expect(received).toHaveLength(sendCount);
    expect((await request('POST', '/conversations/messages', sequence, randomUUID())).status).toBe(
      409,
    );

    const second = await request('POST', '/conversations/messages', {
      ...sequence,
      skill: { id: initial.id, revision: 2 },
    });
    expect(second.ok).toBe(true);
    await second.text();
    expect(JSON.stringify(received.at(-1)?.messages)).toContain(secondBody);
    expect(JSON.stringify(received.at(-1)?.messages)).not.toContain(firstBody);
    const plain = await request('POST', '/conversations/messages', {
      ...sequence,
      skill: undefined,
    });
    expect(plain.ok).toBe(true);
    await plain.text();
    expect(JSON.stringify(received.at(-1)?.messages)).not.toContain(secondBody);
    const history = await request('GET', `/conversations/${conversation.conversation_id}/messages`);
    const { data: page } = z
      .object({ data: ConversationMessagePageSchema })
      .parse(await history.json());
    expect(page.items.filter((m) => m.role === 'user').map((m) => m.skill?.revision)).toEqual([
      1,
      2,
      undefined,
    ]);

    const beforeRevoke = received.length;
    beforeModel = async () => {
      const disabled = await request('POST', `/skills/${initial.id}/actions/disable`, {
        expected_revision: 2,
      });
      expect(disabled.ok).toBe(true);
    };
    const racing = await request('POST', '/conversations/messages', {
      ...sequence,
      skill: { id: initial.id, revision: 2 },
    });
    expect(racing.ok).toBe(true);
    expect(frames(await racing.text()).some((event) => event.type === 'thread.failed')).toBe(true);
    expect(received).toHaveLength(beforeRevoke);
    expect(
      (
        await request('POST', '/conversations/messages', {
          ...sequence,
          skill: { id: initial.id, revision: 2 },
        })
      ).status,
    ).toBe(409);
    const unassigned = await request('POST', `/bots/${bot.id}`, {
      ...config,
      revision: 1,
      skill_ids: [],
    });
    expect(unassigned.ok).toBe(true);
    const rejected = await request('POST', '/conversations/messages', sequence);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      error: { details: { reason: 'SKILL_NOT_ASSIGNED' } },
    });
  }, 30000);
});
