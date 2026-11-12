import { afterEach, expect, spyOn, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { HARNESS_PROTOCOL_VERSION, type HarnessRequest } from '@along/contracts';
import { createUserConfiguredHarnessModelTransport } from '../src/modules/conversations/harness-model.js';
import { createContextPolicy } from '../src/modules/conversations/context-policy.js';
import { measureHarnessContext } from '../src/modules/conversations/harness-context.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      server.closeAllConnections();
      return closed.promise;
    }),
  );
});

const request: Extract<HarnessRequest, { type: 'model' }> = {
  protocol: HARNESS_PROTOCOL_VERSION,
  type: 'model',
  request_ref: 'm1',
  messages: [{ role: 'user', content: 'hello' }],
  remaining_tokens: 1000,
  max_output_tokens: 32,
};
const config = { baseUrl: 'https://user-controlled.invalid/v1', model: 'test-model' };
const chunk = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

async function listen(server: Server): Promise<string> {
  servers.push(server);
  const ready = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', ready.resolve);
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return `http://127.0.0.1:${address.port}/v1/chat/completions`;
}

test('user configuration requires an explicit network boundary', () => {
  expect(() => createUserConfiguredHarnessModelTransport(config, undefined as never)).toThrow();
});

test('a denied network operation never falls back or exposes the boundary error', async () => {
  const globalFetch = spyOn(globalThis, 'fetch');
  let calls = 0;
  try {
    const transport = createUserConfiguredHarnessModelTransport(config, async () => {
      calls++;
      throw new Error('private network policy detail');
    });
    const steps = await Array.fromAsync(transport(request, [], new AbortController().signal));
    expect(calls).toBe(1);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(steps).toEqual([
      {
        type: 'failed',
        error: { code: 'HARNESS_UNAVAILABLE', message: 'harness model transport unavailable' },
        usage: null,
      },
    ]);
  } finally {
    globalFetch.mockRestore();
  }
});

test('user model request uses the boundary while local measurement does not, and remains streaming', async () => {
  const release = Promise.withResolvers<void>();
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk({ content: 'first' }));
    void release.promise.then(() =>
      res.end(chunk({ content: ' second' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'),
    );
  });
  const local = await listen(server);
  let calls = 0;
  let target = '';
  let sentBody = '';
  const transport = createUserConfiguredHarnessModelTransport(config, async (url, init) => {
    calls++;
    target = String(url);
    sentBody = String(init?.body);
    return fetch(local, init);
  });
  const policy = createContextPolicy({ model: config.model, completionCap: 32 });
  const measured = await measureHarnessContext({ ...request, type: 'measure_context' }, [], policy);
  expect(calls).toBe(0);
  const stream = transport(request, [], new AbortController().signal);
  try {
    expect((await stream.next()).value).toEqual({ type: 'delta', delta: 'first' });
    expect(calls).toBe(1);
    expect(target).toBe('https://user-controlled.invalid/v1/chat/completions');
    expect(Buffer.byteLength(sentBody, 'utf8')).toBe(measured.http_bytes);
    release.resolve();
    expect((await Array.fromAsync(stream)).at(-1)).toMatchObject({
      type: 'complete',
      reply: { message: { content: 'first second' }, usage: null },
    });
  } finally {
    release.resolve();
    await stream.return();
  }
});

test('cancellation aborts the injected network operation and its active stream', async () => {
  const closed = Promise.withResolvers<void>();
  const server = createServer((_req, res) => {
    res.once('close', closed.resolve);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk({ content: 'partial' }));
  });
  const local = await listen(server);
  let boundarySignal: AbortSignal | null | undefined;
  const transport = createUserConfiguredHarnessModelTransport(config, async (_url, init) => {
    boundarySignal = init?.signal;
    return fetch(local, init);
  });
  const abort = new AbortController();
  const stream = transport(request, [], abort.signal);
  expect((await stream.next()).value).toEqual({ type: 'delta', delta: 'partial' });
  abort.abort();
  await expect(stream.next()).rejects.toBeDefined();
  expect(boundarySignal?.aborted).toBe(true);
  await closed.promise;
});
