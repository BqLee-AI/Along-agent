import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import type { LookupFunction } from 'node:net';
import { outboundFetchForTest } from '../../src/modules/model-providers/outbound.js';

const server = http.createServer((_req, res) => res.end('pinned'));
const listening = Promise.withResolvers<void>();
server.listen(0, '127.0.0.1', listening.resolve);
await listening.promise;
const address = server.address();
if (!address || typeof address === 'string') throw new Error('server address unavailable');
const pendingLookup = Promise.withResolvers<never>();
let selected = '';
let requests = 0;
const dnsCalls: string[] = [];
const transport = {
  resolve: async (hostname: string) => {
    dnsCalls.push(hostname);
    if (hostname === 'pending.example') return pendingLookup.promise;
    if (hostname === 'private.example') return [{ address: '127.0.0.1', family: 4 }];
    if (hostname === 'mixed.example')
      return [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ];
    return [
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ];
  },
  httpsRequest: (
    url: URL,
    options: http.RequestOptions,
    callback: (response: http.IncomingMessage) => void,
  ) => {
    requests++;
    assert.equal(options.agent, false);
    const pinnedLookup = options.lookup as LookupFunction;
    assert.equal(typeof pinnedLookup, 'function');
    // Exercise the production lookup callback, then map the selected public IP
    // to the isolated loopback server rather than contacting the public Internet.
    const localLookup: LookupFunction = (hostname, lookupOptions, callbackLookup) => {
      pinnedLookup(hostname, lookupOptions, (error, ip, family) => {
        if (error) return callbackLookup(error, ip, family);
        selected = ip as string;
        callbackLookup(null, '127.0.0.1', 4);
      });
    };
    return http.request(
      new URL(`${url.pathname}${url.search}`, `http://${url.host}`),
      { ...options, lookup: localLookup },
      callback,
    );
  },
  httpRequest: http.request,
};
let stage = 'private DNS rejection';
try {
  const port = address.port;
  process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = `http://127.0.0.1:${port}`;
  const privateResult = await outboundFetchForTest(
    `https://private.example:${port}`,
    undefined,
    transport,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal((privateResult as { category?: string } | null)?.category, 'blocked_address');
  stage = 'mixed DNS rejection';
  const mixedResult = await outboundFetchForTest(
    `https://mixed.example:${port}`,
    undefined,
    transport,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal((mixedResult as { category?: string } | null)?.category, 'blocked_address');
  assert.equal(requests, 0);
  stage = 'public DNS pinning and connection';
  const response = await outboundFetchForTest(
    `https://public.example:${port}`,
    undefined,
    transport,
  );
  assert.equal(await response.text(), 'pinned');
  assert.equal(selected, '8.8.8.8');
  assert.equal(requests, 1);
  stage = 'DNS abort';
  const controller = new AbortController();
  const pending = outboundFetchForTest(
    `https://pending.example:${port}`,
    { signal: controller.signal },
    transport,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  controller.abort();
  assert.equal(((await pending) as { name?: string } | null)?.name, 'AbortError');
  assert.deepEqual(dnsCalls, [
    'private.example',
    'mixed.example',
    'public.example',
    'pending.example',
  ]);
} catch (error) {
  throw new Error(`Controlled DNS test failed during ${stage}; DNS calls: ${dnsCalls.join(', ')}`, {
    cause: error,
  });
} finally {
  server.close();
}
