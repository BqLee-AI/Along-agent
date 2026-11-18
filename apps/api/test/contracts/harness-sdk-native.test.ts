import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import { HarnessModelMessageSchema } from '@along/contracts';
import { ThreadEventSchema } from '@along/stream-protocol';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { createUserModelTransport } from '../../src/features/model-providers/runtime/model-transport.js';
import {
  listProviders,
  updateProvider,
} from '../../src/features/model-providers/configuration/service.js';
import type { HarnessConsumer } from '../helpers/harness-consumer.js';
import type * as HarnessHelpers from '../helpers/harness-consumer.js';

// This contract requires an explicitly supplied, disposable local PostgreSQL
// database and an isolated native executable. It never falls back to deployment
// settings, an installed executable, an existing key, or a real provider.
const ModelBody = z.object({
  model: z.literal('sdk-native-fixture'),
  stream: z.literal(true),
  parallel_tool_calls: z.literal(false),
  messages: z.array(HarnessModelMessageSchema),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
});
const Observation = z.object({
  invocationId: z.string().uuid(),
  status: z.literal('ok'),
  result: z.object({ kind: z.literal('prefs'), timezone_id: z.literal('Europe/London') }),
});

let fixture: HarnessConsumer | undefined;
let helpers: typeof HarnessHelpers;
let provider: Server | undefined;
const providerErrors: unknown[] = [];
const requests: z.infer<typeof ModelBody>[] = [];
const release = Promise.withResolvers<void>();
const originalEnv = new Map<string, string | undefined>();
const prefix = 'Controlled stream: ';
const suffix = 'Europe/London.';
let providerBase = '';

function setEnv(name: string, value: string): void {
  originalEnv.set(name, process.env[name]);
  process.env[name] = value;
}

beforeAll(async () => {
  if (process.env.HARNESS_SDK_TEST_ISOLATED !== '1') return;
  const binary = process.env.HARNESS_BINARY;
  const library = process.env.HARNESS_LIBRARY_PATH;
  const database = process.env.HARNESS_SDK_TEST_DATABASE_URL;
  if (
    process.platform !== 'linux' ||
    !binary ||
    !library ||
    !database ||
    process.env.HARNESS_SDK_TEST_ISOLATED !== '1'
  ) {
    throw new Error(
      'Requires Linux, explicitly supplied HARNESS_BINARY and HARNESS_LIBRARY_PATH, HARNESS_SDK_TEST_DATABASE_URL and HARNESS_SDK_TEST_ISOLATED=1; all must be disposable isolated test resources',
    );
  }
  const url = new URL(database);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/along_sdk_test_[a-z0-9_]+$/.test(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'The dedicated test database must be local, named along_sdk_test_<suffix>, and have no URL options',
    );
  }
  setEnv('DATABASE_URL', database);
  setEnv('BETTER_AUTH_SECRET', `synthetic-sdk-native-${randomUUID()}-${randomUUID()}`);
  // Dynamic loading is required: the fixture captures DATABASE_URL at module
  // initialization, which must happen only after the isolation checks above.
  helpers = await import('../helpers/harness-consumer.js');
  // Refuse a fixture module cached by another test with a different database.
  const setup = await import('../integration/setup.js');
  if (setup.databaseUrl !== database)
    throw new Error(
      'Integration fixture was initialized with a different database; run this file in a separate process',
    );
  fixture = await helpers.createHarnessConsumer();
  provider = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions')
        throw new Error('unexpected provider endpoint');
      const body = ModelBody.parse(await helpers.jsonBody(req));
      requests.push(body);
      if (requests.length === 1) {
        expect(body.tools.some((tool) => tool.function.name === 'get_user_prefs')).toBe(true);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'synthetic-provider-call',
                    type: 'function',
                    function: { name: 'get_user_prefs', arguments: '{}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        chunk({ choices: [], usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 } });
        res.end('data: [DONE]\n\n');
        return;
      }
      if (requests.length !== 2) throw new Error('unexpected additional model request');
      const observation = helpers.findModelObservation(body.messages, Observation);
      expect(observation).toMatchObject({
        status: 'ok',
        result: { kind: 'prefs', timezone_id: 'Europe/London' },
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      chunk({ choices: [{ index: 0, delta: { content: prefix }, finish_reason: null }] });
      await release.promise;
      chunk({ choices: [{ index: 0, delta: { content: suffix }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      chunk({ choices: [], usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 } });
      res.end('data: [DONE]\n\n');
    })().catch((error: unknown) => {
      providerErrors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  providerBase = await helpers.listen(provider);
  setEnv('MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS', new URL(providerBase).origin);
  if (!fixture.deps.harness) throw new Error('native harness unavailable');
  fixture.deps.harness = {
    ...fixture.deps.harness,
    contextPolicy: createContextPolicy({ completionCap: 1024, model: 'sdk-native-fixture' }),
  };
  fixture.deps.modelTransport = createUserModelTransport;
}, 30_000);

afterAll(async () => {
  release.resolve();
  try {
    await fixture?.close();
  } finally {
    if (provider?.listening) {
      const closed = once(provider, 'close');
      provider.closeAllConnections();
      provider.close();
      await closed;
    }
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}, 30_000);

test.skipIf(process.env.HARNESS_SDK_TEST_ISOLATED !== '1')(
  'SDK stream crosses the native loop, executes one authorized tool, and sends its real result back to the model',
  async () => {
    if (!fixture) throw new Error('fixture unavailable');
    const actor = await fixture.actor('http');
    const configured = await listProviders(fixture.database.pool, actor.ownerId);
    await updateProvider(fixture.database.pool, actor.ownerId, configured.items[0]!.id, {
      base_url: `${providerBase}/v1`,
    });
    const response = await fixture.request(actor, '/api/v1/conversations/messages', {
      execution: 'harness',
      raw_text: 'Read my timezone and report it.',
      idempotency_key: randomUUID(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    if (!response.body) throw new Error('missing event stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let wire = '';
    try {
      // The provider cannot send its finish, usage, DONE, or EOF until we have
      // observed the first persisted API delta. This tests actual streaming.
      const deadline = AbortSignal.timeout(15_000);
      const timedOut = Promise.withResolvers<never>();
      deadline.addEventListener(
        'abort',
        () => timedOut.reject(new Error('first delta did not arrive before provider completion')),
        { once: true },
      );
      while (
        !helpers
          .frames(wire.slice(0, wire.lastIndexOf('\n') + 1))
          .filter((event) => event.type === 'message.delta')
          .map((event) => event.payload.delta)
          .join('')
          .includes(prefix)
      ) {
        const part = await Promise.race([reader.read(), timedOut.promise]);
        if (part.done) throw new Error('API stream ended before the first delta');
        wire += decoder.decode(part.value, { stream: true });
      }
      expect(requests).toHaveLength(2);
      release.resolve();
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        wire += decoder.decode(part.value, { stream: true });
      }
      wire += decoder.decode();
    } finally {
      release.resolve();
      reader.releaseLock();
    }
    const events = helpers.frames(wire).map((event) => ThreadEventSchema.parse(event));
    const run = helpers.started(events);
    expect(
      events
        .filter((event) => event.type === 'message.delta')
        .map((event) => event.payload.delta)
        .join(''),
    ).toBe(prefix + suffix);
    expect(events.filter((event) => event.type === 'thread.completed')).toHaveLength(1);
    expect(events.some((event) => event.type === 'thread.failed')).toBe(false);
    expect(requests).toHaveLength(2);
    expect(providerErrors).toEqual([]);
    const observation = helpers.findModelObservation(requests[1]!.messages, Observation);
    expect(observation).toBeDefined();
    const rows = await fixture.database.pool.query(
      'SELECT invocation_id,tool_id,state,outcome_kind,accepted_result FROM tool_invocations WHERE run_id=$1',
      [run.run_id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      invocation_id: observation!.invocationId,
      tool_id: 'get_user_prefs',
      state: 'completed',
      outcome_kind: 'success',
      accepted_result: { status: 'ok', result: { kind: 'prefs', timezone_id: 'Europe/London' } },
    });
    expect(await actor.view(run.conversation_id, run.run_id)).toMatchObject({ status: 'done' });
  },
  30_000,
);
