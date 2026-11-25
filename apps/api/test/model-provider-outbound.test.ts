import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import {
  isPublicAddress,
  outboundFetch,
  outboundFetchForTest,
  outboundJson,
} from '../src/features/model-providers/outbound/outbound.js';
import * as http from 'node:http';
import type { LookupFunction } from 'node:net';
import { once } from 'node:events';

describe('provider outbound address policy', () => {
  test('denies internal, mapped and non-global destinations', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
      'fe80::1',
      '2001:db8::1',
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  test('blocks public HTTP before sending credentials or conversation content', async () => {
    let requests = 0;
    const transport = {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      httpRequest: () => {
        requests++;
        throw new Error('unexpected request');
      },
      httpsRequest: () => {
        requests++;
        throw new Error('unexpected request');
      },
    };
    await expect(
      outboundFetchForTest(
        'http://provider.example/v1/chat',
        {
          method: 'POST',
          headers: { authorization: 'Bearer synthetic-test-key' },
          body: 'synthetic conversation',
        },
        transport,
      ),
    ).rejects.toMatchObject({ category: 'blocked_address' });
    expect(requests).toBe(0);
  });

  test('only a deployment-approved exact local origin can be reached', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[{"id":"local/model"}]}');
    });
    const started = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', started.resolve);
    await started.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const previous = process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS;
    try {
      delete process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS;
      await expect(outboundJson(`${origin}/v1`, 'models', null)).rejects.toMatchObject({
        category: 'blocked_address',
      });
      process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = origin;
      expect(await outboundJson(`${origin}/v1`, 'models', null)).toEqual({
        data: [{ id: 'local/model' }],
      });
      await expect(outboundJson('http://169.254.169.254/v1', 'models', null)).rejects.toMatchObject(
        { category: 'blocked_address' },
      );
    } finally {
      if (previous === undefined) delete process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS;
      else process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = previous;
      const stopped = Promise.withResolvers<void>();
      server.close((error) => (error ? stopped.reject(error) : stopped.resolve()));
      await stopped.promise;
    }
  });
});

describe('provider SDK fetch transport', () => {
  test('pins approved loopback requests, streams, aborts and rejects redirects without leaking errors', async () => {
    const received = Promise.withResolvers<{
      method: string;
      header: string | undefined;
      body: string;
    }>();
    const streamClosed = Promise.withResolvers<void>();
    let redirectTargetHits = 0;
    const pendingStarted = Promise.withResolvers<void>();
    const server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/target' });
        res.end();
      } else if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('first\n');
        res.on('close', streamClosed.resolve);
      } else if (req.url === '/pending') {
        pendingStarted.resolve();
      } else if (req.url === '/echo' || req.url === '/target') {
        if (req.url === '/target') redirectTargetHits++;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          received.resolve({
            method: req.method ?? '',
            header: req.headers['x-test'] as string | undefined,
            body: Buffer.concat(chunks).toString(),
          });
          res.writeHead(201, { 'content-type': 'text/plain' });
          res.end('ok');
        });
      } else {
        res.writeHead(500);
        res.end();
      }
    });
    const started = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', started.resolve);
    await started.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const previous = process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS;
    try {
      delete process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS;
      await expect(outboundFetch(`${origin}/echo`)).rejects.toMatchObject({
        category: 'blocked_address',
      });
      process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = `http://127.0.0.1:${address.port === 1 ? 2 : address.port - 1}`;
      await expect(outboundFetch(`${origin}/echo`)).rejects.toMatchObject({
        category: 'blocked_address',
      });
      process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = `${origin}/not-an-origin`;
      await expect(outboundFetch(`${origin}/echo`)).rejects.toMatchObject({
        category: 'blocked_address',
      });
      process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = origin;
      const response = await outboundFetch(
        new Request(`${origin}/echo`, {
          method: 'POST',
          headers: { 'x-test': 'original' },
          body: 'original',
        }),
        { headers: { 'x-test': 'value' }, body: 'payload' },
      );
      expect(response.status).toBe(201);
      expect(await response.text()).toBe('ok');
      expect(await received.promise).toEqual({ method: 'POST', header: 'value', body: 'payload' });
      await expect(
        outboundFetch(`${origin}/redirect`, { redirect: 'follow' }),
      ).rejects.toMatchObject({ category: 'connection' });
      expect(redirectTargetHits).toBe(0);
      await expect(outboundFetch(`http://localhost:${address.port}/echo`)).rejects.toMatchObject({
        category: 'blocked_address',
      });
      await expect(outboundFetch('http://169.254.169.254/')).rejects.toMatchObject({
        category: 'blocked_address',
      });
      await expect(outboundFetch('http://user:secret@127.0.0.1/')).rejects.toMatchObject({
        category: 'invalid_endpoint',
      });

      const beforeHeaders = new AbortController();
      const pending = outboundFetch(`${origin}/pending`, { signal: beforeHeaders.signal });
      await pendingStarted.promise;
      beforeHeaders.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

      const controller = new AbortController();
      const streamed = await outboundFetch(`${origin}/stream`, { signal: controller.signal });
      const reader = streamed.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('first\n');
      controller.abort('secret abort reason');
      await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
      await streamClosed.promise;
      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      await expect(
        outboundFetch(`${origin}/echo`, { signal: alreadyAborted.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      if (previous === undefined) delete process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS;
      else process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = previous;
      const stopped = Promise.withResolvers<void>();
      server.close((error) => (error ? stopped.reject(error) : stopped.resolve()));
      await stopped.promise;
    }
    process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = origin;
    try {
      let failure: unknown;
      try {
        await outboundFetch(`${origin}/?secret=do-not-leak`, {
          headers: { authorization: 'Bearer do-not-leak' },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ category: 'connection' });
      expect(String(failure)).not.toContain('do-not-leak');
    } finally {
      if (previous === undefined) delete process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS;
      else process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = previous;
    }
  });
  test('isolates controlled DNS and socket-binding checks in a child process', async () => {
    const process = Bun.spawn(
      [Bun.which('bun')!, `${import.meta.dir}/fixtures/model-provider-outbound-dns.ts`],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {},
      },
    );
    const [exit, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
  });
});

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
