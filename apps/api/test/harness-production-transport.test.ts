import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { HARNESS_PROTOCOL_VERSION, type HarnessRequest } from '@along/contracts';
import { createContextPolicy } from '../src/features/conversations/public.js';
import { loadHarnessServices } from '../src/agent/runtime/config.js';
import { createUserModelTransport } from '../src/features/model-providers/public.js';

test('production user transport binds SDK measurement and calls only approved outbound destinations', async () => {
  let body = '';
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":3}}\n\ndata: [DONE]\n\n',
      );
    });
  });
  const ready = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', ready.resolve);
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  const origin = `http://127.0.0.1:${address.port}`;
  const previous = process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS;
  const request: Extract<HarnessRequest, { type: 'model' }> = {
    protocol: HARNESS_PROTOCOL_VERSION,
    type: 'model',
    request_ref: 'production-transport',
    messages: [{ role: 'user', content: 'hello' }],
    remaining_tokens: 1000,
    max_output_tokens: 32,
  };
  try {
    const services = loadHarnessServices({
      HARNESS_BINARY: process.execPath,
      HARNESS_COMPLETION_CAP: '32',
    });
    expect(services?.contextPolicy).toMatchObject({
      input_meter: 'estimated',
      meter_revision: 'openai-json-utf8-estimate/1',
      model_window_tokens: null,
    });
    const bounded = loadHarnessServices({
      HARNESS_BINARY: process.execPath,
      HARNESS_COMPLETION_CAP: '32',
      HARNESS_MODEL_WINDOW_TOKENS: '10000',
    });
    expect(bounded?.contextPolicy.model_window_tokens).toBe(10000);
    const planned = loadHarnessServices({
      HARNESS_BINARY: process.execPath,
      HARNESS_COMPLETION_CAP: '32',
      HARNESS_AUTO_COMPACT_PLANNING_TOKENS: '8192',
    });
    expect(planned?.autoCompactPlanningTokens).toBe(8192);
    expect(
      loadHarnessServices({
        HARNESS_BINARY: process.execPath,
        HARNESS_COMPLETION_CAP: '32',
        HARNESS_AUTO_COMPACT_PLANNING_TOKENS: '0',
      }),
    ).toBeNull();
    expect(services?.contextPolicy.completion_cap).toBe(32);
    const transport = await createUserModelTransport({
      base_url: `${origin}/v1`,
      api_key: null,
      model_id: 'configured-model',
    });
    const policy = createContextPolicy({ model: 'configured-model', completionCap: 32 });
    const measurement = await transport.measure(
      { ...request, type: 'measure_context' },
      [],
      policy,
    );
    const estimated = await transport.measure({ ...request, type: 'measure_context' }, [], {
      ...services!.contextPolicy,
      model_binding: {
        ...services!.contextPolicy.model_binding,
        model: 'configured-model',
      },
    });
    expect(estimated.input_meter.quality).toBe('estimated');
    expect(estimated.input_meter.input_tokens).toBeGreaterThan(0);
    expect(estimated.input_meter.meter_revision).toBe('openai-json-utf8-estimate/1');
    expect(estimated.input_meter.input_tokens).toBe(Math.ceil(estimated.http_bytes / 3));
    expect(measurement.input_meter).toMatchObject({
      quality: 'unavailable',
      input_tokens: null,
      meter_revision: 'unavailable/1',
    });
    expect(calls).toBe(0);
    process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = '';
    const blocked = [];
    for await (const step of transport.model(request, [], new AbortController().signal))
      blocked.push(step);
    expect(blocked[0]?.type).toBe('failed');
    expect(calls).toBe(0);
    process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = origin;
    const steps = [];
    for await (const step of transport.model(request, [], new AbortController().signal))
      steps.push(step);
    expect(steps.map((step) => step.type)).toEqual(['delta', 'complete']);
    expect(calls).toBe(1);
    expect(JSON.parse(body).model).toBe('configured-model');
    expect(Buffer.byteLength(body, 'utf8')).toBe(measurement.http_bytes);
    await expect(
      transport.measure(
        { ...request, type: 'measure_context' },
        [],
        createContextPolicy({ model: 'another-model', completionCap: 32 }),
      ),
    ).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS;
    else process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = previous;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
