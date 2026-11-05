import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createServer, type Server, type RequestListener, type ServerResponse } from 'node:http';
import { HARNESS_PROTOCOL_VERSION } from '@along/contracts';
import { createHarnessModelTransport } from '../src/modules/conversations/harness-model.js';
import { loadHarnessServices } from '../src/modules/conversations/harness-config.js';
import { failEnvelope, HttpError } from '../src/http/errors.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function provider(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing provider port');
  return `http://127.0.0.1:${address.port}/v1`;
}

function request(baseUrl: string, signal = new AbortController().signal) {
  const model = createHarnessModelTransport({ baseUrl, model: 'contract-model' });
  return model(
    {
      protocol: HARNESS_PROTOCOL_VERSION,
      type: 'model',
      request_ref: 'm1',
      messages: [{ role: 'user', content: 'hello' }],
      remaining_tokens: 8000,
      max_output_tokens: 512,
    },
    [],
    signal,
  );
}

function chunk(delta: unknown, finish_reason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
}
function complete(res: ServerResponse, reason = 'stop'): void {
  res.write(chunk({}, reason));
  res.write(`data: ${JSON.stringify({ choices: [], usage: { total_tokens: 7 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}
async function rejected(baseUrl: string): Promise<HttpError> {
  const steps = await Array.fromAsync(request(baseUrl));
  expect(steps.some((step) => step.type === 'complete')).toBe(false);
  const failure = steps.at(-1);
  if (failure?.type !== 'failed') throw new Error('unsafe model response accepted');
  expect(failure.usage).toBeNull();
  return new HttpError(
    failure.error.code === 'HARNESS_UNAVAILABLE' ? 503 : 502,
    failure.error.code === 'HARNESS_UNAVAILABLE' ? 503 : 502,
    failure.error.code,
    failure.error.message,
  );
}

describe('harness incremental model HTTP transport', () => {
  test('delivers provider content before the provider finish/usage/DONE/EOF gate opens', async () => {
    const release = Promise.withResolvers<void>();
    let ended = false;
    let body: unknown;
    const baseUrl = await provider((req, res) => {
      void (async () => {
        const parts: Buffer[] = [];
        for await (const bytes of req) parts.push(Buffer.from(bytes));
        body = JSON.parse(Buffer.concat(parts).toString());
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(chunk({ content: '先回答😀' }));
        await release.promise;
        res.write(chunk({ content: '，然后完成。' }));
        ended = true;
        complete(res);
      })();
    });
    const stream = request(baseUrl);
    try {
      expect(await stream.next()).toEqual({
        done: false,
        value: { type: 'delta', delta: '先回答😀' },
      });
      expect(ended).toBe(false);
      expect(body).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
        parallel_tool_calls: false,
        max_tokens: 512,
      });
      release.resolve();
      const rest = await Array.fromAsync(stream);
      expect(rest).toEqual([
        { type: 'delta', delta: '，然后完成。' },
        {
          type: 'complete',
          reply: {
            message: { content: '先回答😀，然后完成。', tool_calls: [] },
            usage: { total_tokens: 7 },
          },
        },
      ]);
    } finally {
      release.resolve();
      await stream.return();
    }
  });

  test('handles split UTF8, CRLF, SSE comments and multiline data without replacing Unicode', async () => {
    const baseUrl = await provider((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      const wire =
        ': comment\r\n\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"中😀文"},"finish_reason":null}]}\r\n\r\n';
      for (const byte of Buffer.from(wire)) res.write(Buffer.from([byte]));
      complete(res);
    });
    const steps = await Array.fromAsync(request(baseUrl));
    expect(steps[0]).toEqual({ type: 'delta', delta: '中😀文' });
    expect(steps.at(-1)).toMatchObject({
      type: 'complete',
      reply: { message: { content: '中😀文' } },
    });
  });
  test('decodes deterministically one-byte HTTP body chunks including split multibyte scalars', async () => {
    const bytes = Buffer.from(
      chunk({ content: '中😀文' }) + chunk({}, 'stop') + 'data: [DONE]\n\n',
    );
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
    try {
      expect(await Array.fromAsync(request('https://controlled-byte-fixture.invalid/v1'))).toEqual([
        { type: 'delta', delta: '中😀文' },
        {
          type: 'complete',
          reply: { message: { content: '中😀文', tool_calls: [] }, usage: null },
        },
      ]);
    } finally {
      fetch.mockRestore();
    }
  });

  test('assembles function metadata and JSON arguments only into the final tool proposal with usage', async () => {
    const baseUrl = await provider((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        chunk({
          content: '先读取。',
          tool_calls: [
            {
              index: 0,
              id: 'call-',
              type: 'function',
              function: { name: 'get_', arguments: '{"note":' },
            },
          ],
        }),
      );
      res.write(
        chunk({
          tool_calls: [
            { index: 0, id: '1', function: { name: 'user_prefs', arguments: '"中😀文"}' } },
          ],
        }),
      );
      complete(res, 'tool_calls');
    });
    expect(await Array.fromAsync(request(baseUrl))).toEqual([
      { type: 'delta', delta: '先读取。' },
      {
        type: 'complete',
        reply: {
          message: {
            content: '先读取。',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'get_user_prefs', arguments: '{"note":"中😀文"}' },
              },
            ],
          },
          usage: { total_tokens: 7 },
        },
      },
    ]);
  });

  test('assembles indexed parallel proposals without executing or dropping either', async () => {
    const baseUrl = await provider((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'first',
              type: 'function',
              function: { name: 'cancel_reminder', arguments: '{"task":' },
            },
            {
              index: 1,
              id: 'second',
              type: 'function',
              function: { name: 'cancel_reminder', arguments: '{"task":' },
            },
          ],
        }),
      );
      res.write(
        chunk({
          tool_calls: [
            { index: 1, function: { arguments: '"b"}' } },
            { index: 0, function: { arguments: '"a"}' } },
          ],
        }),
      );
      complete(res, 'tool_calls');
    });
    const steps = await Array.fromAsync(request(baseUrl));
    expect(steps.at(-1)).toMatchObject({
      type: 'complete',
      reply: {
        message: {
          tool_calls: [
            { id: 'first', function: { name: 'cancel_reminder', arguments: '{"task":"a"}' } },
            { id: 'second', function: { name: 'cancel_reminder', arguments: '{"task":"b"}' } },
          ],
        },
      },
    });
  });

  test('bounds actual large provider deltas without cutting Unicode scalars', async () => {
    const answer = 'a'.repeat(3999) + '😀界';
    const baseUrl = await provider((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ content: answer }));
      complete(res);
    });
    const steps = await Array.fromAsync(request(baseUrl));
    const deltas = steps.flatMap((step) => (step.type === 'delta' ? [step.delta] : []));
    expect(deltas).toHaveLength(2);
    expect(deltas.join('')).toBe(answer);
    for (const delta of deltas) {
      expect(delta.length).toBeLessThanOrEqual(4000);
      expect(delta.isWellFormed()).toBe(true);
    }
  });

  test('upstream error bodies do not enter failed steps or the public error envelope', async () => {
    const privateBody = 'private-provider-diagnostic-do-not-disclose';
    const baseUrl = await provider((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: privateBody }));
    });
    const steps = await Array.fromAsync(request(baseUrl));
    expect(steps).toEqual([
      {
        type: 'failed',
        error: {
          code: 'HARNESS_UNAVAILABLE',
          message: 'harness model transport unavailable',
        },
        usage: null,
      },
    ]);
    expect(JSON.stringify(steps)).not.toContain(privateBody);
    const error = await rejected(baseUrl);
    expect(error.errorCode).toBe('HARNESS_UNAVAILABLE');
    expect(error.httpStatus).toBe(503);
    expect(JSON.stringify(failEnvelope(error, 'model-boundary'))).not.toContain(privateBody);
  });

  test('rejects complete JSON responses instead of silently retrying without streaming', async () => {
    let calls = 0;
    const baseUrl = await provider((_req, res) => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'not streamed' } }] }));
    });
    expect((await rejected(baseUrl)).errorCode).toBe('HARNESS_PROTOCOL_ERROR');
    expect(calls).toBe(1);
  });

  test('rejects a truncated response containing parallel proposals', async () => {
    const baseUrl = await provider((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        chunk({
          tool_calls: [
            { index: 0, id: 'c1' },
            { index: 1, id: 'c2' },
          ],
        }),
      );
    });
    expect((await rejected(baseUrl)).errorCode).toBe('HARNESS_PROTOCOL_ERROR');
  });

  test('invalid UTF8 is rejected rather than replaced in a visible answer', async () => {
    const baseUrl = await provider((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        Buffer.concat([
          Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"'),
          Buffer.from([0xff]),
          Buffer.from('"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
        ]),
      );
    });
    expect((await rejected(baseUrl)).errorCode).toBe('HARNESS_PROTOCOL_ERROR');
  });

  test('bounds an individual event and cumulative final reply separately', async () => {
    for (const aggregate of [false, true]) {
      const baseUrl = await provider((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (aggregate)
          for (let i = 0; i < 17; i++) res.write(chunk({ content: 'x'.repeat(65536) }));
        else res.write(chunk({ content: 'x'.repeat(1024 * 1024) }));
        complete(res);
      });
      expect((await rejected(baseUrl)).errorCode).toBe('HARNESS_PROTOCOL_ERROR');
    }
  });

  for (const failure of ['eof', 'error', 'length'] as const) {
    test(`retains a genuine first delta but never reports completion after midstream ${failure}`, async () => {
      const baseUrl = await provider((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(chunk({ content: '部分答案' }));
        if (failure === 'error') res.end('data: {"error":{"message":"private error"}}\n\n');
        else if (failure === 'length') res.end(chunk({}, 'length'));
        else res.end();
      });
      const stream = request(baseUrl);
      expect((await stream.next()).value).toEqual({ type: 'delta', delta: '部分答案' });
      expect(await stream.next()).toMatchObject({
        done: false,
        value: { type: 'failed', error: { code: 'HARNESS_PROTOCOL_ERROR' }, usage: null },
      });
    });
  }

  for (const afterDelta of [false, true]) {
    test(`cancelling ${afterDelta ? 'after a delta' : 'before content'} closes a stalled provider`, async () => {
      const started = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<boolean>();
      const baseUrl = await provider((_req, res) => {
        res.once('close', () => closed.resolve(!res.writableEnded && res.destroyed));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(afterDelta ? chunk({ content: '已开始' }) : ': waiting\n\n', () =>
          started.resolve(),
        );
      });
      const controller = new AbortController();
      const stream = request(baseUrl, controller.signal);
      const first = stream.next();
      await started.promise;
      if (afterDelta) expect((await first).value).toEqual({ type: 'delta', delta: '已开始' });
      const waiting = afterDelta ? stream.next() : first;
      const result = waiting.then(
        () => false,
        () => true,
      );
      controller.abort();
      expect(await result).toBe(true);
      expect(await closed.promise).toBe(true);
    });
  }

  test('a midstream socket failure keeps the first delta but never invents a complete response', async () => {
    const release = Promise.withResolvers<void>();
    const baseUrl = await provider((_req, res) => {
      void (async () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(chunk({ content: '真实片段' }));
        await release.promise;
        res.destroy();
      })();
    });
    const stream = request(baseUrl);
    try {
      expect((await stream.next()).value).toEqual({ type: 'delta', delta: '真实片段' });
      release.resolve();
      expect(await stream.next()).toMatchObject({
        done: false,
        value: { type: 'failed', error: { code: 'HARNESS_UNAVAILABLE' }, usage: null },
      });
    } finally {
      release.resolve();
      await stream.return();
    }
  });

  test('returning a paused iterator closes provider even without an external abort', async () => {
    const closed = Promise.withResolvers<boolean>();
    const baseUrl = await provider((_req, res) => {
      res.once('close', () => closed.resolve(!res.writableEnded && res.destroyed));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ content: 'partial' }));
    });
    const stream = request(baseUrl);
    expect((await stream.next()).value).toEqual({ type: 'delta', delta: 'partial' });
    await stream.return();
    expect(await closed.promise).toBe(true);
  });
});

describe('harness deployment-only cumulative budgets', () => {
  const environment = {
    HARNESS_MODEL_BASE_URL: 'http://127.0.0.1:9000/v1',
    HARNESS_MODEL: 'deployment-model',
    HARNESS_BINARY: process.execPath,
    HARNESS_COMPLETION_CAP: '512',
  };
  test('invalid deployment budgets fail closed instead of enabling a fallback', () => {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
      expect(loadHarnessServices({ ...environment, HARNESS_MAX_ITERATIONS: value })).toBeNull();
      expect(loadHarnessServices({ ...environment, HARNESS_MAX_TOKENS: value })).toBeNull();
    }
  });
  test('requires an explicit positive safe completion cap independently of the Run budget', () => {
    expect(loadHarnessServices({ ...environment, HARNESS_COMPLETION_CAP: undefined })).toBeNull();
    for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
      expect(loadHarnessServices({ ...environment, HARNESS_COMPLETION_CAP: value })).toBeNull();
    }
    const services = loadHarnessServices({ ...environment, HARNESS_MAX_TOKENS: '8000' });
    expect(services?.maxTokens).toBe(8000);
    expect(services?.contextPolicy.completion_cap).toBe(512);
  });
});

describe('harness R2-A model failure accounting', () => {
  test('length termination preserves accepted deltas and usage without completing partial arguments', async () => {
    const baseUrl = await provider((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ content: 'visible prefix' }));
      res.write(
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                type: 'function',
                function: { name: 'list_tasks', arguments: '{"partial":' },
              },
            ],
          },
          'length',
        ),
      );
      res.write(`data: ${JSON.stringify({ choices: [], usage: { total_tokens: 73 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    const steps = await Array.fromAsync(request(baseUrl));
    expect(steps[0]).toEqual({ type: 'delta', delta: 'visible prefix' });
    expect(steps.at(-1)).toMatchObject({
      type: 'failed',
      error: { code: 'HARNESS_CONTEXT_LIMIT' },
      usage: { total_tokens: 73 },
    });
    expect(steps.some((step) => step.type === 'complete')).toBe(false);
  });

  test('structured provider window rejection is a capacity failure without diagnostic leakage', async () => {
    const baseUrl = await provider((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'context_length_exceeded', message: 'private prompt diagnostic' },
        }),
      );
    });
    const steps = await Array.fromAsync(request(baseUrl));
    expect(steps).toEqual([
      {
        type: 'failed',
        error: {
          code: 'HARNESS_CONTEXT_LIMIT',
          message: 'harness model context capacity exceeded',
        },
        usage: null,
      },
    ]);
    expect(JSON.stringify(steps)).not.toContain('private prompt diagnostic');
  });
});
