import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { handleRequest } from '../src/http/app.js';
import type { Actor } from '../src/http/auth.js';

const LIMIT = 131072;
const approval = '/api/v1/approvals/00000000-0000-4000-8000-000000000001/actions/reject';
const paths = [
  approval,
  '/api/v1/conversations/messages',
  '/api/v1/tasks/00000000-0000-4000-8000-000000000001/actions/cancel',
];
const servers: Server[] = [];
const actor: Actor = { ownerId: 'owner', sessionId: null, displayName: '', timezoneId: null };

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
});

async function api(identity: Actor | null = actor) {
  const server = createServer((req, res) => {
    void handleRequest(req, res, { pool: null, resolveActor: async () => identity }).catch(() =>
      res.destroy(),
    );
  });
  servers.push(server);
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: {
    code: number;
    data: unknown;
    request_id: string;
    error: { code: string; request_id: string; details?: unknown };
  };
  closed: Promise<void>;
}

function upload(
  base: string,
  path: string,
  chunks: (string | Buffer)[],
  end = true,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  const req = request(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
  });
  const closure = Promise.withResolvers<void>();
  req.once('close', closure.resolve);
  const closed = closure.promise;
  // A real HTTP deadline detects a response that incorrectly waits for end;
  // fake time cannot drive the platform socket or the server's upload stream.
  req.setTimeout(1500, () => req.destroy(new Error('no response before upload end')));
  req.on('error', reject);
  req.on('response', (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      text += chunk;
    });
    res.on('error', reject);
    res.on('end', () => {
      req.setTimeout(0);
      try {
        resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(text), closed });
      } catch (error) {
        reject(error);
      }
    });
  });
  req.flushHeaders();
  for (const chunk of chunks) req.write(chunk);
  if (end) req.end();
  return promise;
}

function envelope(reply: Reply, status: number, code: string, id?: string) {
  expect(reply.status).toBe(status);
  expect(reply.body).toMatchObject({ code: status, data: null, error: { code } });
  expect(reply.headers['x-request-id']).toBe(reply.body.request_id);
  expect(reply.body.error.request_id).toBe(reply.body.request_id);
  if (id) expect(reply.body.request_id).toBe(id);
}

async function closes(reply: Reply) {
  expect(reply.headers.connection).toBe('close');
  await reply.closed;
}

function padded(bytes: number, unicode = false): Buffer {
  const prefix = '{"idempotency_key":"00000000-0000-4000-8000-000000000001","padding":"';
  const suffix = '"}';
  const available = bytes - Buffer.byteLength(prefix + suffix);
  const text = unicode
    ? '水'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3)
    : 'x'.repeat(available);
  return Buffer.from(prefix + text + suffix);
}

describe('HTTP request body boundary', () => {
  it('rejects unauthenticated uploads without waiting for end across protected routes', async () => {
    const base = await api(null);
    for (const path of paths) {
      const reply = await upload(base, path, ['{"prefix":"', 'x'.repeat(1024)], false, {
        'x-request-id': 'finite-upload-43',
      });
      envelope(reply, 401, 'UNAUTHENTICATED', 'finite-upload-43');
      await closes(reply);
    }
    console.info(
      '[finite upload] three protected routes: 1035-byte unfinished uploads -> 401 and closed',
    );
  });

  it('rejects missing and invalid CSRF before upload end using the existing session actor', async () => {
    const base = await api({ ...actor, sessionId: 'session' });
    for (const path of paths) {
      for (const headers of [{}, { 'x-csrf-token': 'invalid' }] as Record<string, string>[]) {
        const reply = await upload(base, path, ['{'], false, headers);
        envelope(reply, 403, 'FORBIDDEN');
        expect(reply.body.error.details).toEqual({ reason: 'CSRF_MISMATCH' });
        await closes(reply);
      }
    }
  });

  it('accepts small JSON into business validation with the same generated request id', async () => {
    const base = await api();
    const reply = await upload(base, approval, [
      '{"idempotency_key":"00000000-0000-4000-8000-000000000001"}',
    ]);
    envelope(reply, 503, 'NOT_READY'); // Parsed business input reaches the existing unavailable DB gate.
  });

  it('rejects a declared oversized body before any body bytes arrive', async () => {
    const reply = await upload(await api(), approval, [], false, {
      'content-length': String(LIMIT + 1),
    });
    // Flush headers without ending or supplying the declared body.
    envelope(reply, 413, 'PAYLOAD_TOO_LARGE');
    await closes(reply);
  });

  it('rejects a single-write oversized body while upload remains unfinished', async () => {
    const reply = await upload(await api(), approval, [padded(LIMIT + 1)], false, {
      'x-request-id': 'single-byte-boundary',
    });
    envelope(reply, 413, 'PAYLOAD_TOO_LARGE', 'single-byte-boundary');
    await closes(reply);
  });

  it('counts cumulative chunks and UTF8 bytes, allowing exactly the limit', async () => {
    const base = await api();
    const exact = padded(LIMIT, true);
    expect(exact.toString('utf8').length).toBeLessThan(LIMIT);
    envelope(
      await upload(base, approval, [exact.subarray(0, 65535), exact.subarray(65535)]),
      503,
      'NOT_READY',
    );
    const over = padded(LIMIT + 1, true);
    const reply = await upload(
      base,
      approval,
      [over.subarray(0, 65000), over.subarray(65000, LIMIT), over.subarray(LIMIT)],
      false,
    );
    envelope(reply, 413, 'PAYLOAD_TOO_LARGE');
    await closes(reply);
    console.info(
      '[finite upload] UTF8: 131072 bytes accepted; 131073 bytes unfinished chunked upload -> 413 and closed',
    );
  });

  it('reports empty and malformed JSON as validation errors with envelope request ids', async () => {
    const base = await api();
    for (const text of ['', '{"broken":', '{"x":}'])
      envelope(await upload(base, approval, [text]), 400, 'VALIDATION_ERROR');
  });

  it('answers unknown routes without draining an unfinished upload', async () => {
    const reply = await upload(await api(), '/missing', ['{'], false);
    envelope(reply, 404, 'NOT_FOUND');
    await closes(reply);
  });

  it('finishes an aborted upload and can serve a subsequent request', async () => {
    const base = await api();
    const arrived = once(servers.at(-1)!, 'request');
    const req = request(`${base}${approval}`, { method: 'POST' });
    req.on('error', () => {});
    req.write('{');
    const [incoming] = await arrived;
    const serverClosed = Promise.withResolvers<void>();
    incoming.once('close', serverClosed.resolve);
    const closed = Promise.withResolvers<void>();
    req.once('close', closed.resolve);
    req.destroy();
    await closed.promise;
    await serverClosed.promise;
    expect(incoming.listenerCount('data')).toBe(0);
    expect(incoming.listenerCount('end')).toBe(0);
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
  });
});
