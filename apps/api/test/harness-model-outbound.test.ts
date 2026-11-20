import { afterEach, expect, spyOn, test } from 'bun:test';
import { createServer, request as httpRequest, type ClientRequest, type Server } from 'node:http';
import { HARNESS_PROTOCOL_VERSION, type HarnessRequest } from '@along/contracts';
import { createConfiguredSdkStep } from '../src/features/model-providers/public.js';
import { createContextPolicy } from '../src/features/conversations/public.js';
import { measureSdkContext } from '../src/features/model-providers/public.js';
import {
  OutboundError,
  outboundFetchForTest,
} from '../src/features/model-providers/outbound/outbound.js';
import { forbidden } from '../src/platform/errors.js';

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
  expect(() => createConfiguredSdkStep(config, undefined as never)).toThrow();
});

test.each([false, true])(
  'dispatch enqueues under guard after DNS (revoked: %s)',
  async (revoked) => {
    const dnsStarted = Promise.withResolvers<void>();
    const finishDns = Promise.withResolvers<void>();
    const guardFinished = Promise.withResolvers<void>();
    let authorized = true;
    let dispatched: ClientRequest | undefined;
    let enqueuedInsideGuard = false;
    let received = '';
    const local = await listen(
      createServer((req, res) => {
        req.setEncoding('utf8');
        req.on('data', (part: string) => (received += part));
        req.on('end', () => {
          // A guard that waits for the provider response cannot complete this request.
          void guardFinished.promise.then(() => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(chunk({ content: 'accepted' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
          });
        });
      }),
    );
    const model = createConfiguredSdkStep(config, (url, init, authorizeDispatch) =>
      outboundFetchForTest(
        url,
        init,
        {
          resolve: async () => {
            dnsStarted.resolve();
            await finishDns.promise;
            authorized = !revoked;
            return [{ address: '8.8.8.8', family: 4 }];
          },
          httpRequest: () => {
            throw new Error('unexpected HTTP destination');
          },
          httpsRequest: (_url, options, callback) => {
            dispatched = httpRequest(local, options, callback);
            return dispatched;
          },
        },
        authorizeDispatch,
      ),
    );
    const steps = Array.fromAsync(
      model(request, [], new AbortController().signal, async (enqueue) => {
        if (!authorized) throw forbidden('Feishu observation authorization expired');
        enqueue();
        enqueuedInsideGuard = dispatched?.writableEnded === true;
        guardFinished.resolve();
      }),
    );
    await Promise.race([
      dnsStarted.promise,
      steps.then(() => {
        throw new Error('model finished before DNS started');
      }),
    ]);
    finishDns.resolve();

    const result = await steps;
    if (revoked) {
      expect(dispatched).toBeUndefined();
      expect(received).toBe('');
      expect(result).toEqual([
        {
          type: 'failed',
          error: { code: 'FORBIDDEN', message: 'Feishu observation authorization expired' },
          usage: null,
        },
      ]);
    } else {
      expect(enqueuedInsideGuard).toBe(true);
      expect(JSON.parse(received)).toMatchObject({ messages: request.messages });
      expect(result.at(-1)).toMatchObject({
        type: 'complete',
        reply: { message: { content: 'accepted' } },
      });
    }
  },
);

test('guarded dispatch prepares the body first and honors cancellation before enqueue', async () => {
  const guardEntered = Promise.withResolvers<boolean>();
  const releaseGuard = Promise.withResolvers<void>();
  const abort = new AbortController();
  let prepared = false;
  let opened = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('serialized body'));
        controller.close();
        prepared = true;
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit = { method: 'POST', signal: abort.signal, body, duplex: 'half' };
  const pending = outboundFetchForTest(
    config.baseUrl,
    init,
    {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      httpRequest: () => {
        throw new Error('unexpected HTTP destination');
      },
      httpsRequest: () => {
        opened = true;
        throw new Error('unexpected HTTPS request');
      },
    },
    async (enqueue) => {
      guardEntered.resolve(prepared);
      await releaseGuard.promise;
      enqueue();
    },
  );
  const preparedBeforeGuard = await Promise.race([
    guardEntered.promise,
    pending.then(() => {
      throw new Error('response arrived before dispatch authorization');
    }),
  ]);
  abort.abort();
  releaseGuard.resolve();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(preparedBeforeGuard).toBe(true);
  expect(opened).toBe(false);
});

test('ordinary outbound requests stream their upload without buffering it', async () => {
  const receivedFirst = Promise.withResolvers<string>();
  const local = await listen(
    createServer((req, res) => {
      let received = '';
      req.setEncoding('utf8');
      req.on('data', (part: string) => {
        received += part;
        receivedFirst.resolve(received);
      });
      req.on('end', () => res.end(received));
    }),
  );
  const source = new TransformStream<Uint8Array, Uint8Array>();
  const writer = source.writable.getWriter();
  const encoder = new TextEncoder();
  const init: RequestInit = { method: 'POST', body: source.readable, duplex: 'half' };
  const response = outboundFetchForTest(config.baseUrl, init, {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    httpRequest: () => {
      throw new Error('unexpected HTTP destination');
    },
    httpsRequest: (_url, options, callback) => httpRequest(local, options, callback),
  });
  const [, first] = await Promise.all([
    writer.write(encoder.encode('first')),
    Promise.race([
      receivedFirst.promise,
      response.then(() => {
        throw new Error('response arrived before the upload completed');
      }),
    ]),
  ]);
  try {
    expect(first).toBe('first');
    await writer.write(encoder.encode(' second'));
  } finally {
    await writer.close();
  }
  expect(await (await response).text()).toBe('first second');
});

test('a denied network operation never falls back or exposes the boundary error', async () => {
  const globalFetch = spyOn(globalThis, 'fetch');
  let calls = 0;
  try {
    const transport = createConfiguredSdkStep(config, async () => {
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

test('reports a safe outbound failure category without exposing error details', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const transport = createConfiguredSdkStep(config, async () => {
      throw new OutboundError('blocked_address');
    });
    const steps = await Array.fromAsync(transport(request, [], new AbortController().signal));
    expect(steps.at(-1)).toMatchObject({ type: 'failed', error: { code: 'HARNESS_UNAVAILABLE' } });
    expect(warn.mock.calls.map((args) => JSON.parse(String(args[0])))).toContainEqual({
      event: 'MODEL_TRANSPORT_UNAVAILABLE',
      reason: 'outbound_blocked_address',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(config.baseUrl);
  } finally {
    warn.mockRestore();
  }
});

test('reports an outbound disconnect while reading an accepted response body', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    let sent = false;
    const transport = createConfiguredSdkStep(
      config,
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(new TextEncoder().encode(chunk({ content: 'accepted' })));
              } else {
                controller.error(new OutboundError('connection'));
              }
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const steps = await Array.fromAsync(transport(request, [], new AbortController().signal));
    expect(steps.at(-1)).toMatchObject({
      type: 'failed',
      error: { code: 'HARNESS_UNAVAILABLE' },
      usage: null,
    });
    expect(warn.mock.calls.map((args) => JSON.parse(String(args[0])))).toContainEqual({
      event: 'MODEL_TRANSPORT_UNAVAILABLE',
      reason: 'outbound_connection',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(config.baseUrl);
  } finally {
    warn.mockRestore();
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
  const transport = createConfiguredSdkStep(config, async (url, init) => {
    calls++;
    target = String(url);
    sentBody = String(init?.body);
    return fetch(local, init);
  });
  const policy = createContextPolicy({ model: config.model, completionCap: 32 });
  const measured = await measureSdkContext({ ...request, type: 'measure_context' }, [], policy);
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
  const transport = createConfiguredSdkStep(config, async (_url, init) => {
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
