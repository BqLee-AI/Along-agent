import { afterEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { createHarnessModelTransport } from '../src/modules/model-providers/harness-model.js';
import { createContextPolicy } from '../src/modules/conversations/context-policy.js';
import {
  buildHarnessModelBody,
  measureHarnessContext,
} from '../src/modules/conversations/harness-context.js';
import type { HarnessRequest } from '@along/contracts';

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

test('R2-A sends the independent completion cap rather than the cumulative balance to the provider', async () => {
  const captured = Promise.withResolvers<Record<string, unknown>>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    captured.resolve(body);
    if (body.stream !== true) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 8 } }),
      );
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    res.end(
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"total_tokens":8}}\n\ndata: [DONE]\n\n',
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const model = createHarnessModelTransport({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'bounded',
  });
  const response = model(
    {
      protocol: 'harness/v6',
      type: 'model',
      request_ref: 'm1',
      messages: [{ role: 'user', content: 'hello' }],
      remaining_tokens: 64000,
      max_output_tokens: 37,
    },
    [],
    new AbortController().signal,
  );
  const collected = (async () => {
    const steps = [];
    for await (const step of response) steps.push(step);
    return steps;
  })();
  const body = await captured.promise;
  expect(body.max_tokens).toBe(37);
  expect(body.stream).toBe(true);
  expect((await collected).at(-1)).toMatchObject({
    type: 'complete',
    reply: { message: { content: 'ok' } },
  });
});

test('verified complete input enforces both window reserve and cumulative balance before a request', async () => {
  const policy = createContextPolicy({
    completionCap: 37,
    model: 'bounded',
    modelWindowTokens: 121,
    reserveTokens: 20,
    inputMeter: 'verified',
    meterRevision: 'complete-fixture/1',
  });
  const candidate: Extract<HarnessRequest, { type: 'measure_context' }> = {
    protocol: 'harness/v6',
    type: 'measure_context',
    request_ref: 'm1',
    messages: [{ role: 'user', content: 'hello' }],
    remaining_tokens: 1000,
    max_output_tokens: 37,
  };
  const meter = () => ({
    quality: 'verified' as const,
    input_tokens: 100,
    meter_revision: 'complete-fixture/1',
  });
  expect(await measureHarnessContext(candidate, [], policy, meter)).toMatchObject({
    output_ceiling: 1,
    limit_reason: null,
  });
  expect(
    await measureHarnessContext({ ...candidate, remaining_tokens: 100 }, [], policy, meter),
  ).toMatchObject({ output_ceiling: 0, limit_reason: 'budget' });
  expect(
    await measureHarnessContext({ ...candidate, remaining_tokens: 101 }, [], policy, meter),
  ).toMatchObject({ output_ceiling: 1, limit_reason: null });
  expect(
    await measureHarnessContext(candidate, [], { ...policy, model_window_tokens: 120 }, meter),
  ).toMatchObject({ output_ceiling: 0, limit_reason: 'context' });
  expect(
    await measureHarnessContext(
      { ...candidate, remaining_tokens: 0 },
      [],
      { ...policy, model_window_tokens: 120 },
      meter,
    ),
  ).toMatchObject({ limit_reason: 'budget' });
});

test('missing current meter and missing provider usage remain unknown rather than inventing capacity', async () => {
  const policy = createContextPolicy({
    completionCap: 37,
    model: 'bounded',
    modelWindowTokens: 1,
    inputMeter: 'verified',
    meterRevision: 'temporarily-offline/1',
  });
  const candidate: Extract<HarnessRequest, { type: 'measure_context' }> = {
    protocol: 'harness/v6',
    type: 'measure_context',
    request_ref: 'm1',
    messages: [{ role: 'user', content: 'hello' }],
    remaining_tokens: null,
    max_output_tokens: 37,
  };
  expect(await measureHarnessContext(candidate, [], policy)).toMatchObject({
    output_ceiling: 37,
    limit_reason: null,
    input_meter: { quality: 'unavailable', input_tokens: null, meter_revision: 'unavailable/1' },
  });
});

test('SDK preview serializes an accepted unanswered tool call without inventing a result', async () => {
  const candidate: Extract<HarnessRequest, { type: 'measure_context' }> = {
    protocol: 'harness/v8',
    type: 'measure_context',
    request_ref: 'preview',
    messages: [
      { role: 'user', content: 'read preferences' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'pending-call',
            type: 'function',
            function: { name: 'get_user_prefs', arguments: '{}' },
          },
        ],
      },
    ],
    remaining_tokens: 1000,
    max_output_tokens: 37,
  };
  const body = JSON.parse(await buildHarnessModelBody('bounded', candidate, []));
  expect(body.messages.at(-1)).toMatchObject({
    role: 'assistant',
    tool_calls: [
      {
        id: 'pending-call',
        type: 'function',
        function: { name: 'get_user_prefs', arguments: '{}' },
      },
    ],
  });
  expect(body.messages.some((message: { role: string }) => message.role === 'tool')).toBe(false);
});

test('SDK preflight meters the exact body later sent without contacting the provider', async () => {
  let requests = 0;
  let sent = '';
  const server = createServer(async (req, res) => {
    requests++;
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    sent = Buffer.concat(parts).toString('utf8');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  servers.push(server);
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const policy = createContextPolicy({
    completionCap: 37,
    model: 'opaque/model',
    inputMeter: 'verified',
    meterRevision: 'capture/1',
  });
  const candidate: Extract<HarnessRequest, { type: 'model' }> = {
    protocol: 'harness/v6',
    type: 'model',
    request_ref: 'm1',
    messages: [
      { role: 'system', content: '系统' },
      { role: 'user', content: '你好😀' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{malformed' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '结果' },
    ],
    remaining_tokens: 1000,
    max_output_tokens: 37,
  };
  let measured = '';
  const measurement = await measureHarnessContext(candidate, [], policy, (body) => {
    measured = body;
    return { quality: 'verified', input_tokens: 10, meter_revision: 'capture/1' };
  });
  expect(requests).toBe(0);
  const transport = createHarnessModelTransport({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'opaque/model',
  });
  expect(
    (await Array.fromAsync(transport(candidate, [], new AbortController().signal))).at(-1),
  ).toMatchObject({ type: 'complete' });
  expect(requests).toBe(1);
  expect(sent).toBe(measured);
  expect(JSON.parse(sent).messages[2].tool_calls[0].function.arguments).toBe('{malformed');
  expect(measurement.http_bytes).toBe(Buffer.byteLength(sent, 'utf8'));
});
