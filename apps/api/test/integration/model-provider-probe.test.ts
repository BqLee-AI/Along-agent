import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import type { HarnessServices } from '../../src/modules/conversations/harness-process.js';
import type { ConversationDeps } from '../../src/modules/conversations/contracts.js';
import {
  createProvider,
  listProviders,
  testProvider,
  updateProvider,
} from '../../src/modules/model-providers/service.js';
import { handleRequest } from '../../src/http/app.js';
import { csrfTokenFor } from '../../src/http/auth.js';
import { createUserModelTransport } from '../../src/modules/conversations/harness-config.js';

const schema = `probe_test_${randomUUID().replaceAll('-', '')}`;
const url = process.env.MODEL_PROVIDER_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;
const admin = new Pool({ connectionString: url ?? 'postgresql://invalid' });
const pool = new Pool({
  connectionString: url ?? 'postgresql://invalid',
  options: `-c search_path=${schema}`,
});
const owner = randomUUID();
const factoryFor =
  (model: HarnessServices['model']): NonNullable<ConversationDeps['modelTransport']> =>
  async () => ({
    model,
    measure: () => {
      throw new Error('measurement is not used by probe');
    },
  });

suite('draft model provider probe', () => {
  beforeAll(async () => {
    process.env.MODEL_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(
      "CREATE TABLE schema_migrations(version text PRIMARY KEY); INSERT INTO schema_migrations(version) VALUES ('0027')",
    );
    await pool.query('CREATE TABLE agent_runs(id uuid PRIMARY KEY, owner_id uuid NOT NULL)');
    await pool.query(await readFile('infra/migrations/0028_model_providers.sql', 'utf8'));
  });
  afterAll(async () => {
    delete process.env.MODEL_PROVIDER_ENCRYPTION_KEY;
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  test('authorizes the owner and never reuses a stored key at a draft endpoint', async () => {
    const provider = await createProvider(pool, owner, 'Probe');
    await updateProvider(pool, owner, provider.id, {
      base_url: 'https://saved.example/v1',
      credential: { action: 'replace', api_key: 'saved-secret' },
    });
    await expect(testProvider(pool, randomUUID(), provider.id, {})).rejects.toThrow();
    await expect(
      testProvider(pool, owner, provider.id, { base_url: 'https://draft.example/v1' }),
    ).rejects.toThrow();
    const empty = await testProvider(pool, owner, provider.id, {});
    expect(empty.text_stream.status).toBe('not_tested');
    await expect(testProvider(pool, owner, provider.id, { model_id: 'model' })).rejects.toThrow();
    const seen: Array<string | null> = [];
    const model: HarnessServices['model'] = async function* () {
      yield { type: 'delta', delta: 'ok' };
      yield {
        type: 'complete',
        reply: { message: { content: 'ok', tool_calls: [] }, usage: null },
      };
    };
    const baseFactory = factoryFor(model);
    const factory: NonNullable<ConversationDeps['modelTransport']> = async (config) => {
      seen.push(config.api_key);
      return baseFactory(config);
    };
    await testProvider(pool, owner, provider.id, { model_id: 'model' }, factory);
    await testProvider(
      pool,
      owner,
      provider.id,
      {
        base_url: 'https://draft.example/v1',
        model_id: 'model',
        credential: { action: 'replace', api_key: 'draft-secret' },
      },
      factory,
    );
    await testProvider(
      pool,
      owner,
      provider.id,
      { base_url: 'https://draft.example/v1', model_id: 'model', credential: { action: 'clear' } },
      factory,
    );
    expect(seen).toEqual(['saved-secret', 'draft-secret', null]);
    const view = await listProviders(pool, owner);
    expect(view.items.find((item) => item.id === provider.id)?.base_url).toBe(
      'https://saved.example/v1',
    );
    expect(JSON.stringify(view)).not.toContain('secret');
    const versions = await pool.query(
      'SELECT count(*)::int AS count FROM model_provider_versions WHERE provider_id=$1',
      [provider.id],
    );
    expect(versions.rows[0].count).toBe(2);
  });
  test('reports only completed synthetic streaming, tool round trip and usage', async () => {
    const provider = await createProvider(pool, owner, 'Capabilities');
    const requests: Array<{ messages: unknown; tools: unknown }> = [];
    const model: HarnessServices['model'] = async function* (request, tools) {
      requests.push({ messages: request.messages, tools });
      if (requests.length === 2) {
        yield {
          type: 'complete',
          reply: {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'probe_echo', arguments: '{"value":"probe"}' },
                },
              ],
            },
            usage: null,
          },
        };
      } else {
        yield { type: 'delta', delta: 'ok' };
        yield {
          type: 'complete',
          reply: { message: { content: 'ok', tool_calls: [] }, usage: { total_tokens: 5 } },
        };
      }
    };
    const result = await testProvider(
      pool,
      owner,
      provider.id,
      { base_url: 'https://draft.example/v1', model_id: 'model', credential: { action: 'clear' } },
      factoryFor(model),
    );
    expect(result.text_stream.status).toBe('passed');
    expect(result.tool_round_trip.status).toBe('passed');
    expect(result.usage.status).toBe('passed');
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests)).toContain('probe_echo');
    expect(JSON.stringify(requests)).not.toContain('saved-secret');
    expect(requests[0]!.tools).toEqual([]);
    expect(JSON.stringify(requests[2]!.messages)).toContain('call-1');
  });
  test('does not report tool success without a complete round trip or usage', async () => {
    const provider = await createProvider(pool, owner, 'Incomplete');
    await expect(
      testProvider(pool, owner, provider.id, { base_url: 'https://draft.example/v1' }),
    ).rejects.toThrow();
    const model: HarnessServices['model'] = async function* () {
      yield { type: 'delta', delta: 'ok' };
      yield {
        type: 'complete',
        reply: { message: { content: 'ok', tool_calls: [] }, usage: null },
      };
    };
    const result = await testProvider(
      pool,
      owner,
      provider.id,
      { base_url: 'https://draft.example/v1', model_id: 'model', credential: { action: 'clear' } },
      factoryFor(model),
    );
    expect(result.text_stream.status).toBe('passed');
    expect(result.tool_round_trip.status).toBe('failed');
    expect(result.usage.status).toBe('failed');
  });
  test('HTTP probe enforces CSRF and owner before calling the injected transport', async () => {
    const provider = await createProvider(pool, owner, 'HTTP probe');
    const actor = {
      ownerId: owner,
      sessionId: randomUUID(),
      displayName: 'Test',
      timezoneId: null,
    };
    let calls = 0;
    const model: HarnessServices['model'] = async function* () {
      calls++;
      yield { type: 'delta', delta: 'ok' };
      yield {
        type: 'complete',
        reply: { message: { content: 'ok', tool_calls: [] }, usage: null },
      };
    };
    const server = createServer((req, res) => {
      void handleRequest(req, res, {
        pool,
        tzdbVersion: 'fixture-v1',
        resolveActor: async () => actor,
        modelTransport: factoryFor(model),
      });
    });
    const started = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', started.resolve);
    await started.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const url = `http://127.0.0.1:${address.port}/api/v1/model-providers/${provider.id}/actions/test`;
    const body = JSON.stringify({
      base_url: 'https://draft.example/v1',
      model_id: 'model',
      credential: { action: 'clear' },
    });
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrfTokenFor(actor)! };
    try {
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          })
        ).status,
      ).toBe(403);
      actor.ownerId = randomUUID();
      expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(403);
      expect(calls).toBe(0);
      actor.ownerId = owner;
      const response = await fetch(url, { method: 'POST', headers, body });
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        data: { text_stream: { status: string }; tool_round_trip: { status: string } };
      };
      expect(result.data.text_stream.status).toBe('passed');
      expect(result.data.tool_round_trip.status).toBe('failed');
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  test('real SDK probes use the saved owner credential through the controlled outbound path', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          messages: Array<{ role: string }>;
          tools?: unknown[];
        };
        seen.push(req.headers.authorization ?? '');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const toolRequest =
          !!body.tools?.length && !body.messages.some((message) => message.role === 'tool');
        const delta = toolRequest
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'probe-call',
                  type: 'function',
                  function: { name: 'probe_echo', arguments: '{\"value\":\"probe\"}' },
                },
              ],
            }
          : { content: 'ok' };
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: toolRequest ? 'tool_calls' : 'stop' }] })}\n\n`,
        );
        res.end(
          'data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\ndata: [DONE]\n\n',
        );
      })().catch(() => res.destroy());
    });
    const ready = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', ready.resolve);
    await ready.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const previous = process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS;
    process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = origin;
    try {
      const other = randomUUID();
      const first = await createProvider(pool, owner, 'First SDK probe');
      const second = await createProvider(pool, other, 'Second SDK probe');
      await updateProvider(pool, owner, first.id, {
        base_url: `${origin}/v1`,
        credential: { action: 'replace', api_key: 'first-test-key' },
      });
      await updateProvider(pool, other, second.id, {
        base_url: `${origin}/v1`,
        credential: { action: 'replace', api_key: 'second-test-key' },
      });
      await expect(
        testProvider(pool, other, first.id, { model_id: 'test-model' }, createUserModelTransport),
      ).rejects.toThrow();
      for (const [who, id] of [
        [owner, first.id],
        [other, second.id],
      ] as const) {
        const result = await testProvider(
          pool,
          who,
          id,
          { model_id: 'test-model' },
          createUserModelTransport,
        );
        expect(result.text_stream.status).toBe('passed');
        expect(result.tool_round_trip.status).toBe('passed');
        expect(result.usage.status).toBe('passed');
      }
      expect(seen).toEqual([
        'Bearer first-test-key',
        'Bearer first-test-key',
        'Bearer first-test-key',
        'Bearer second-test-key',
        'Bearer second-test-key',
        'Bearer second-test-key',
      ]);
    } finally {
      if (previous === undefined) delete process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS;
      else process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = previous;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  test('redacts upstream failures and forwards cancellation', async () => {
    const provider = await createProvider(pool, owner, 'Failure');
    const broken: HarnessServices['model'] = async function* () {
      throw new Error('draft-secret upstream response');
    };
    const failure = await testProvider(
      pool,
      owner,
      provider.id,
      {
        base_url: 'https://draft.example/v1',
        model_id: 'model',
        credential: { action: 'replace', api_key: 'draft-secret' },
      },
      factoryFor(broken),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).not.toBeNull();
    expect(String(failure)).not.toContain('draft-secret');
    const controller = new AbortController();
    const cancellable: HarnessServices['model'] = async function* (_request, _tools, signal) {
      controller.abort();
      expect(signal.aborted).toBe(true);
      yield { type: 'delta', delta: 'not accepted' };
    };
    await expect(
      testProvider(
        pool,
        owner,
        provider.id,
        {
          base_url: 'https://draft.example/v1',
          model_id: 'model',
          credential: { action: 'clear' },
        },
        factoryFor(cancellable),
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
