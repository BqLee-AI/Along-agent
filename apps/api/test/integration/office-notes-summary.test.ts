import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EnvelopeSchema } from '@along/contracts';
import {
  addModel,
  createConfiguredSdkStep,
  createProvider,
  setDefault,
  updateProvider,
  type ModelTransportFactory,
  type SdkStepNetwork,
} from '../../src/features/model-providers/public.js';
import { createApp, type App } from '../../src/http/app.js';
import { attachConnection } from '../../src/http/transport/metadata.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
} from './setup.js';

const baseUrl = 'https://office-summary.invalid/v1';
const modelId = 'office-fixture';
const notesLimit = 48 * 1024;
const root = 'https://localhost/api/v1/model-providers';
const suite = databaseUrl ? describe : describe.skip;
const summary = '项目决定按期发布。';

function sse(delta: object, finish: string, done = true) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n` +
      (done ? 'data: [DONE]\n\n' : ''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

suite('stateless office notes summary HTTP contract', () => {
  let db: IntegrationDatabase;
  let previous: string | undefined;
  let ownerId: string;
  let otherOwnerId: string;
  let providerId: string;

  beforeAll(async () => {
    previous = process.env.ALONG_NATIVE_OFFICE_ADMISSION;
    process.env.ALONG_NATIVE_OFFICE_ADMISSION = '1';
    db = await createIntegrationDatabase();
    ownerId = randomUUID();
    otherOwnerId = randomUUID();
    for (const id of [ownerId, otherOwnerId]) {
      await db.pool.query('INSERT INTO users(id, auth_email) VALUES($1, $2)', [
        id,
        `${id}@office-summary.invalid`,
      ]);
      await admitTestUser(db.pool, id);
    }
    const provider = await createProvider(db.pool, ownerId, 'Office fixture');
    providerId = provider.id;
    await updateProvider(db.pool, ownerId, providerId, { base_url: baseUrl });
    await addModel(db.pool, ownerId, providerId, modelId);
    await setDefault(db.pool, ownerId, { provider_id: providerId, model_id: modelId });
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.ALONG_NATIVE_OFFICE_ADMISSION;
    else process.env.ALONG_NATIVE_OFFICE_ADMISSION = previous;
    await db?.close();
  });

  function appFor(network: SdkStepNetwork, owner = ownerId) {
    const modelTransport: ModelTransportFactory = async (config) => ({
      model: createConfiguredSdkStep({ baseUrl: config.base_url, model: config.model_id }, network),
      measure: () => {
        throw new Error('summary must not request a context measurement');
      },
    });
    return createApp({
      pool: db.pool,
      modelTransport,
      resolveActor: async () => ({
        ownerId: owner,
        sessionId: null,
        displayName: 'Office fixture',
        timezoneId: null,
      }),
    });
  }

  function post(app: App, body: object, signal?: AbortSignal) {
    const request = new Request(`${root}/actions/summarize-notes`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      signal,
    });
    attachConnection(request, { encrypted: true, remoteAddress: null, localAddress: null });
    return app.handle(request);
  }

  test('admits the UTF-8 limit and sends one prompt without tools to the owner default', async () => {
    const notes = '会'.repeat(notesLimit / 3);
    const sent: Array<{ url: string; body: unknown }> = [];
    const app = appFor(async (url, init, authorizeDispatch) => {
      await authorizeDispatch!(() => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      });
      return sse({ content: summary }, 'stop');
    });
    const capability = await app.handle(new Request(`${root}/office-capability`));
    expect(EnvelopeSchema.parse(await capability.json()).data).toEqual({ enabled: true });
    const result = await post(app, { notes });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(EnvelopeSchema.parse(await result.json()).data).toEqual({ summary });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${baseUrl}/chat/completions`);
    expect(sent[0]?.body).toMatchObject({ model: modelId, max_tokens: 2048 });
    expect(sent[0]?.body).not.toHaveProperty('tools');
    expect(sent[0]?.body).not.toHaveProperty('tool_choice');
    expect(sent[0]?.body).toMatchObject({
      messages: [
        { role: 'system', content: expect.any(String) },
        { role: 'user', content: notes },
      ],
    });
    const { rows } = await db.pool.query('SELECT id FROM agent_runs WHERE owner_id=$1', [ownerId]);
    expect(rows).toHaveLength(0);
  });

  test('rejects disabled admission, foreign defaults, extra fields and oversize notes before dispatch', async () => {
    let dispatches = 0;
    const network: SdkStepNetwork = async () => {
      dispatches++;
      return sse({ content: summary }, 'stop');
    };
    const app = appFor(network);
    expect((await post(app, { notes: '会'.repeat(notesLimit / 3) + 'a' })).status).toBe(400);
    expect((await post(app, { notes: 'notes', base_url: 'https://other.invalid' })).status).toBe(
      400,
    );
    expect((await post(appFor(network, otherOwnerId), { notes: 'notes' })).status).toBe(409);
    process.env.ALONG_NATIVE_OFFICE_ADMISSION = 'true';
    try {
      expect((await post(app, { notes: 'notes' })).status).toBe(404);
    } finally {
      process.env.ALONG_NATIVE_OFFICE_ADMISSION = '1';
    }
    expect(dispatches).toBe(0);
  });

  test('rechecks the provider revision at enqueue and declines stale requests', async () => {
    let dispatches = 0;
    const app = appFor(async (_url, _init, authorizeDispatch) => {
      await updateProvider(db.pool, ownerId, providerId, { name: 'New revision' });
      await authorizeDispatch!(() => dispatches++);
      return sse({ content: summary }, 'stop');
    });
    const result = await post(app, { notes: 'notes' });
    expect(result.status).toBe(409);
    expect(EnvelopeSchema.parse(await result.json()).data).toBeNull();
    expect(dispatches).toBe(0);
  });

  test('rejects a request if the owner becomes ineligible before enqueue', async () => {
    let dispatches = 0;
    const app = appFor(async (_url, _init, authorizeDispatch) => {
      await db.pool.query("UPDATE users SET status='disabled' WHERE id=$1", [ownerId]);
      await authorizeDispatch!(() => dispatches++);
      return sse({ content: summary }, 'stop');
    });
    try {
      const result = await post(app, { notes: 'notes' });
      expect(result.status).toBe(403);
      expect(EnvelopeSchema.parse(await result.json()).data).toBeNull();
      expect(dispatches).toBe(0);
    } finally {
      await db.pool.query("UPDATE users SET status='active' WHERE id=$1", [ownerId]);
    }
  });

  test.each([
    ['truncated', 'stop', false, { content: summary }],
    ['token-limited', 'length', true, { content: summary }],
    ['oversized', 'stop', true, { content: '大'.repeat(5500) }],
    [
      'tool-call',
      'tool_calls',
      true,
      {
        tool_calls: [
          {
            index: 0,
            id: 'unexpected',
            type: 'function',
            function: { name: 'unexpected_tool', arguments: '{}' },
          },
        ],
      },
    ],
  ] as const)(
    'rejects %s output without returning partial content or retrying',
    async (_kind, finish, done, delta) => {
      let dispatches = 0;
      const app = appFor(async (_url, _init, authorizeDispatch) => {
        await authorizeDispatch!(() => dispatches++);
        return sse(delta, finish, done);
      });
      const result = await post(app, { notes: 'notes' });
      expect(result.status).toBe(502);
      expect(EnvelopeSchema.parse(await result.json()).data).toBeNull();
      expect(dispatches).toBe(1);
    },
  );

  test('client cancellation aborts the controlled transport and returns no summary', async () => {
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const app = appFor(async (_url, init, authorizeDispatch) => {
      await authorizeDispatch!(() => undefined);
      const signal = init?.signal;
      if (!signal) throw new Error('missing transport signal');
      const response = Promise.withResolvers<Response>();
      signal.addEventListener(
        'abort',
        () => {
          stopped.resolve();
          response.reject(signal.reason);
        },
        { once: true },
      );
      started.resolve();
      return response.promise;
    });
    const abort = new AbortController();
    const pending = post(app, { notes: 'notes' }, abort.signal);
    await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error('request ended before dispatch');
      }),
    ]);
    abort.abort();
    await stopped.promise;
    const result = await pending;
    expect(result.status).toBe(504);
    expect(EnvelopeSchema.parse(await result.json()).data).toBeNull();
  });
});
