import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, request, type Server } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createTlsServer, request as tlsRequest } from 'node:https';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Pool } from 'pg';
import { handleRequest } from './helpers/http-app.js';
import type { Actor } from '../src/features/identity/session/actor.js';

const LIMIT = 131072;
const id = '00000000-0000-4000-8000-000000000001';
const encodedId = `%30${id.slice(1)}`;
const approval = `/api/v1/approvals/${id}/actions/reject`;
const paths = [approval, '/api/v1/conversations/messages', `/api/v1/tasks/${id}/actions/cancel`];
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

async function api(identity: Actor | null = actor, pool: Pool | null = null) {
  const server = createServer((req, res) => {
    void handleRequest(req, res, { pool, resolveActor: async () => identity }).catch(() =>
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
  it('preserves exact methods and duplicate query rejection', async () => {
    const base = await api();
    expect((await fetch(`${base}/healthz`, { method: 'HEAD' })).status).toBe(404);
    const duplicate = await fetch(
      `${base}/api/v1/conversations/${id}/runs/${id}/events?after_seq=1&after_seq=2`,
    );
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('requires literal UUIDs in dynamic GET paths', async () => {
    const base = await api();
    for (const [path, message] of [
      [`/api/v1/tasks/${encodedId}`, 'task not found'],
      [`/api/v1/tasks/${encodedId}/events`, 'task not found'],
      [`/api/v1/approvals/${encodedId}`, 'approval not found'],
      [`/api/v1/document-approvals/${encodedId}`, 'document approval not found'],
      [`/api/v1/conversations/${encodedId}`, 'conversation not found'],
      [`/api/v1/conversations/${id}/runs/${encodedId}`, 'Run not found'],
      [
        `/api/v1/conversations/${id}/runs/${id}/compacts/${encodedId}`,
        'compact operation not found',
      ],
    ]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND', message } });
    }
    expect((await fetch(`${base}/api/v1/tasks/${id}`)).status).toBe(503);
  });

  it('validates write IDs after auth, CSRF and JSON parsing but before body schemas', async () => {
    const encodedApproval = `/api/v1/approvals/${encodedId}/actions/reject`;
    envelope(await upload(await api(null), encodedApproval, ['{']), 401, 'UNAUTHENTICATED');
    const csrf = await upload(await api({ ...actor, sessionId: 'session' }), encodedApproval, [
      '{',
    ]);
    envelope(csrf, 403, 'FORBIDDEN');
    expect(csrf.body.error.details).toEqual({ reason: 'CSRF_MISMATCH' });

    const base = await api();
    envelope(await upload(base, encodedApproval, ['{']), 400, 'VALIDATION_ERROR');
    for (const [path, message] of [
      [encodedApproval, 'approval not found'],
      [`/api/v1/document-approvals/${encodedId}/actions/reject`, 'document approval not found'],
      [`/api/v1/tasks/${encodedId}/actions/cancel`, 'task not found'],
      [`/api/v1/conversations/${id}/runs/${encodedId}/actions/cancel`, 'Run not found'],
    ]) {
      const reply = await upload(base, path, ['{}']);
      envelope(reply, 404, 'NOT_FOUND');
      expect(reply.body.error).toMatchObject({ message });
    }
    envelope(await upload(base, approval, ['{}']), 400, 'VALIDATION_ERROR');
  });

  it('checks memory availability before validating the literal UUID', async () => {
    const detail = `/api/v1/memories/${encodedId}`;
    const action = `${detail}/actions/stop-recall`;
    const unavailable = await api();
    const response = await fetch(`${unavailable}${detail}`);
    expect(response.status).toBe(503);
    envelope(await upload(unavailable, action, ['{']), 400, 'VALIDATION_ERROR');
    envelope(await upload(unavailable, action, ['{}']), 503, 'NOT_READY');

    // Configure the real service but disallow database access: these requests fail at the API.
    const pool = new Pool();
    await pool.end();
    const base = await api(actor, pool);
    const encoded = await fetch(`${base}${detail}`);
    expect(encoded.status).toBe(404);
    expect(await encoded.json()).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'memory not found' },
    });
    envelope(await upload(base, action, ['{}']), 404, 'NOT_FOUND');
    envelope(
      await upload(base, `/api/v1/memories/${id}/actions/stop-recall`, ['{}']),
      400,
      'VALIDATION_ERROR',
    );
  });

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

  it('answers unknown routes promptly and closes an unfinished upload', async () => {
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

// Exercise the production handler over actual sockets, not a synthetic response.
// The certificate and its disposable key exist only in memory for this test process.
describe('unfinished uploads over HTTP and TLS', () => {
  const cases = [
    {
      name: 'unauthenticated',
      identity: null,
      path: approval,
      status: 401,
      code: 'UNAUTHENTICATED',
    },
    {
      name: 'CSRF',
      identity: { ...actor, sessionId: 'session' },
      path: approval,
      status: 403,
      code: 'FORBIDDEN',
    },
    { name: 'unknown path', identity: actor, path: '/missing', status: 404, code: 'NOT_FOUND' },
    {
      name: 'declared oversized',
      identity: actor,
      path: approval,
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      declared: true,
    },
    {
      name: 'chunked oversized',
      identity: actor,
      path: approval,
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    },
  ];
  let tlsMaterial: { key: string; cert: string } | undefined;

  function certificate() {
    if (tlsMaterial) return tlsMaterial;
    const result = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        '-',
        '-out',
        '-',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
    const key = result.stdout.match(
      /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/,
    )?.[0];
    const cert = result.stdout.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,
    )?.[0];
    if (!key || !cert) throw new Error('openssl did not generate test TLS material');
    return (tlsMaterial = { key, cert });
  }

  for (const tls of [false, true]) {
    for (const mode of ['slow', 'continuous'] as const) {
      for (const scenario of cases) {
        it(`${tls ? 'TLS' : 'HTTP'} ${mode} ${scenario.name} returns a complete error and closes`, async () => {
          const observation = Promise.withResolvers<number>();
          const onRequest = (req: IncomingMessage, res: ServerResponse) => {
            let maxBuffered = req.readableLength;
            // Real-time sampling does not consume or resume the request stream.
            const sample = setInterval(() => {
              maxBuffered = Math.max(maxBuffered, req.readableLength);
            }, 1);
            req.socket.once('close', () => {
              clearInterval(sample);
              observation.resolve(Math.max(maxBuffered, req.readableLength));
            });
            void handleRequest(req, res, {
              pool: null,
              resolveActor: async () => scenario.identity,
            }).catch(() => res.destroy());
          };
          const server = tls ? createTlsServer(certificate(), onRequest) : createServer(onRequest);
          servers.push(server);
          const listening = once(server, 'listening');
          server.listen(0, '127.0.0.1');
          await listening;
          const port = (server.address() as AddressInfo).port;
          const started = performance.now();
          const response = Promise.withResolvers<Reply>();
          const closed = Promise.withResolvers<void>();
          const req = (tls ? tlsRequest : request)({
            hostname: '127.0.0.1',
            port,
            path: scenario.path,
            method: 'POST',
            ...(tls ? { rejectUnauthorized: false } : {}),
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'socket-upload-test',
              ...(scenario.declared ? { 'content-length': String(8 * 1024 * 1024) } : {}),
            },
          });
          let sent = 0;
          let receivedStatus: number | undefined;
          let receivedHeaders: IncomingHttpHeaders | undefined;
          let receivedBody = '';
          let responseEnded = false;
          const failed = (error: Error) => {
            if (!responseEnded) {
              console.info(
                `[upload incomplete] ${tls ? 'TLS' : 'HTTP'} ${mode} ${scenario.name}: status=${receivedStatus ?? 'none'} headers=${JSON.stringify(receivedHeaders ?? null)} body=${JSON.stringify(receivedBody)} sent=${sent} elapsed=${Math.round(performance.now() - started)}ms error=${error.message}`,
              );
              response.reject(error);
            }
          };
          const chunk = Buffer.alloc(8192, 120);
          // Real sockets and a live producer need wall-clock pacing and a real deadline.
          const deadline = setTimeout(
            () => req.destroy(new Error('upload rejection exceeded 2 seconds')),
            2000,
          );
          const timer = setInterval(
            () => {
              if (sent >= 4 * 1024 * 1024) {
                req.destroy(new Error('upload exceeded 4 MiB before connection closed'));
                return;
              }
              if (!req.destroyed) {
                req.write(chunk);
                sent += chunk.length;
              }
            },
            mode === 'slow' ? 10 : 1,
          );
          req.once('close', () => {
            clearInterval(timer);
            closed.resolve();
          });
          req.once('error', failed);
          req.once('response', (res) => {
            if (mode === 'continuous') {
              // Real socket buffering and close timing cannot be driven by fake time.
              res.pause();
              setTimeout(() => res.resume(), 100);
            }
            receivedStatus = res.statusCode;
            receivedHeaders = res.headers;
            res.setEncoding('utf8');
            res.on('data', (part: string) => {
              receivedBody += part;
              if (receivedBody.length > 65536)
                req.destroy(new Error('error response exceeded 64 KiB'));
            });
            res.once('error', failed);
            res.once('end', () => {
              responseEnded = true;
              try {
                response.resolve({
                  status: res.statusCode!,
                  headers: res.headers,
                  body: JSON.parse(receivedBody),
                  closed: closed.promise,
                });
              } catch (error) {
                response.reject(error);
              }
            });
          });
          try {
            req.flushHeaders();
            req.write(chunk);
            sent += chunk.length;
            const reply = await response.promise;
            envelope(reply, scenario.status, scenario.code, 'socket-upload-test');
            if (scenario.name === 'CSRF')
              expect(reply.body.error.details).toEqual({ reason: 'CSRF_MISMATCH' });
            await closes(reply);
            const maxBuffered = await observation.promise;
            expect(performance.now() - started).toBeLessThan(2000);
            expect(maxBuffered).toBeLessThan(2 * 1024 * 1024);
            // The peer cannot receive more payload than the producer offered.
            expect(sent).toBeLessThan(4 * 1024 * 1024);
            console.info(
              `[upload socket] ${tls ? 'TLS' : 'HTTP'} ${mode} ${scenario.name}: sent=${sent} max-sampled-buffer=${maxBuffered} elapsed=${Math.round(performance.now() - started)}ms`,
            );
          } finally {
            clearTimeout(deadline);
            clearInterval(timer);
            req.destroy();
          }
        }, 10000);
      }
    }
  }
});
