import { expect, test } from 'bun:test';
import * as http from 'node:http';
import type { LookupFunction } from 'node:net';
import { once } from 'node:events';
import { outboundFetchForTest } from '../src/features/model-providers/outbound/outbound.js';

test('only an explicitly approved HTTPS origin may use fake DNS addresses', async () => {
  const server = http.createServer((_req, res) => res.end('fixture'));
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('missing server');
  let selected = '';
  let connections = 0;
  let records = [{ address: '198.18.0.53', family: 4 }];
  const request = (
    url: URL,
    options: http.RequestOptions,
    callback: (res: http.IncomingMessage) => void,
  ) => {
    connections++;
    const original = options.lookup as LookupFunction;
    const lookup: LookupFunction = (host, opt, cb) =>
      original(host, opt, (err, ip, family) => {
        if (err) return cb(err, ip, family);
        selected = ip as string;
        cb(null, '127.0.0.1', 4);
      });
    return http.request(
      `http://${url.hostname}:${addr.port}${url.pathname}`,
      { ...options, lookup },
      callback,
    );
  };
  const transport = { resolve: async () => records, httpRequest: request, httpsRequest: request };
  const origin = 'https://fake-provider.example';
  const previous = process.env.MODEL_PROVIDER_ALLOWED_FAKE_DNS_ORIGINS;
  const failure = async (url: string) =>
    (await outboundFetchForTest(url, undefined, transport).then(
      () => null,
      (error: unknown) => error,
    )) as { category?: string } | null;
  try {
    delete process.env.MODEL_PROVIDER_ALLOWED_FAKE_DNS_ORIGINS;
    expect((await failure(`${origin}/v1/models`))?.category).toBe('blocked_address');
    process.env.MODEL_PROVIDER_ALLOWED_FAKE_DNS_ORIGINS = origin;
    expect((await failure('http://fake-provider.example/v1/models'))?.category).toBe(
      'blocked_address',
    );
    expect((await failure('https://other.example/v1/models'))?.category).toBe('blocked_address');
    expect((await failure('https://fake-provider.example:8443/v1/models'))?.category).toBe(
      'blocked_address',
    );
    records = [
      { address: '198.18.0.53', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];
    expect((await failure('https://198.18.0.53/v1/models'))?.category).toBe('blocked_address');
    expect((await failure(`${origin}/v1/models`))?.category).toBe('blocked_address');
    expect(connections).toBe(0);
    records = [{ address: '198.18.0.53', family: 4 }];
    const response = await outboundFetchForTest(`${origin}/v1/models`, undefined, transport);
    expect(await response.text()).toBe('fixture');
    expect(selected).toBe('198.18.0.53');
  } finally {
    if (previous === undefined) delete process.env.MODEL_PROVIDER_ALLOWED_FAKE_DNS_ORIGINS;
    else process.env.MODEL_PROVIDER_ALLOWED_FAKE_DNS_ORIGINS = previous;
    server.closeAllConnections();
    server.close();
  }
});
