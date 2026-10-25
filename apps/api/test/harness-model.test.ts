import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server, type RequestListener } from 'node:http';
import { createHarnessModelTransport } from '../src/modules/conversations/harness-model.js';
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

async function request(baseUrl: string, signal = new AbortController().signal) {
  const model = createHarnessModelTransport({ baseUrl, model: 'contract-model' });
  return model(
    {
      protocol: 'harness/v1',
      type: 'model',
      request_ref: 'm1',
      messages: [{ role: 'user', content: 'hello' }],
      remaining_tokens: 100,
    },
    [],
    signal,
  );
}

async function rejected(baseUrl: string): Promise<HttpError> {
  try {
    await request(baseUrl);
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('unsafe model response accepted');
}

describe('harness actual model HTTP rejection boundary', () => {
  test('upstream error bodies do not enter the public error envelope', async () => {
    const privateBody = 'private-provider-diagnostic-do-not-disclose';
    const baseUrl = await provider((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: privateBody }));
    });
    const error = await rejected(baseUrl);
    expect(error.errorCode).toBe('HARNESS_UNAVAILABLE');
    expect(error.httpStatus).toBe(503);
    expect(JSON.stringify(failEnvelope(error, 'model-boundary'))).not.toContain(privateBody);
  });

  test('parallel function proposals are rejected instead of selecting the first', async () => {
    const call = { id: 'c1', type: 'function', function: { name: 'list_tasks', arguments: '{}' } };
    const baseUrl = await provider((_req, res) => {
      res.end(
        JSON.stringify({
          choices: [{ message: { content: null, tool_calls: [call, { ...call, id: 'c2' }] } }],
        }),
      );
    });
    expect((await rejected(baseUrl)).errorCode).toBe('HARNESS_PROTOCOL_ERROR');
  });

  test('invalid UTF8 inside an otherwise valid quoted answer is not replaced and accepted', async () => {
    const baseUrl = await provider((_req, res) => {
      res.end(
        Buffer.concat([
          Buffer.from('{"choices":[{"message":{"content":"'),
          Buffer.from([0xff]),
          Buffer.from('"}}]}'),
        ]),
      );
    });
    expect((await rejected(baseUrl)).errorCode).toBe('HARNESS_PROTOCOL_ERROR');
  });

  test('an oversized valid JSON answer fails before it can be exposed', async () => {
    const baseUrl = await provider((_req, res) => {
      res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(1024 * 1024) } }] }));
    });
    expect((await rejected(baseUrl)).errorCode).toBe('HARNESS_PROTOCOL_ERROR');
  });

  test('cancelling a stalled response closes the real provider stream without completing its body', async () => {
    const started = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<{ ended: boolean; destroyed: boolean }>();
    const baseUrl = await provider((_req, res) => {
      res.once('close', () =>
        closed.resolve({ ended: res.writableEnded, destroyed: res.destroyed }),
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":[', () => started.resolve());
    });
    const controller = new AbortController();
    const result = request(baseUrl, controller.signal).then(
      () => ({ accepted: true }),
      () => ({ accepted: false }),
    );
    await started.promise;
    controller.abort();
    expect(await result).toEqual({ accepted: false });
    expect(await closed.promise).toEqual({ ended: false, destroyed: true });
  });
});
