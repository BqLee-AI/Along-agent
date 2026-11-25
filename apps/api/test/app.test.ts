import { describe, expect, it } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleRequest } from './helpers/http-app.js';
import type { Pool } from 'pg';
import { createTimeContext } from '../src/features/time/context.js';

interface FakeResponse extends ServerResponse {
  status: number;
  resHeaders: Record<string, string>;
  payload: string;
}

function fakePair(method: string, url: string, headers: Record<string, string> = {}) {
  const req = Object.assign(Readable.from([]), { method, url, headers }) as IncomingMessage;
  const res = {
    status: 0,
    resHeaders: {} as Record<string, string>,
    payload: '',
    writeHead(status: number, resHeaders: Record<string, string>) {
      const self = this as FakeResponse;
      self.status = status;
      self.resHeaders = resHeaders;
    },
    end(body: string) {
      const self = this as FakeResponse;
      self.payload = body;
    },
  } as unknown as FakeResponse;
  return { req, res, body: () => JSON.parse(res.payload) as Record<string, unknown> };
}

function errorCode(payload: Record<string, unknown>): string {
  const error = payload.error;
  if (error && typeof error === 'object' && 'code' in error) {
    return String(error.code);
  }
  throw new Error('expected error.code in payload');
}

describe('app', () => {
  it('history collections report dependency failure rather than missing routes or empty history', async () => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    for (const path of [
      '/api/v1/conversations',
      `/api/v1/conversations/${conversationId}/messages`,
      `/api/v1/conversations/${conversationId}/runs`,
    ]) {
      const { req, res, body } = fakePair('GET', path);
      await handleRequest(req, res, {
        pool: null,
        tzdbVersion: '2024a',
        resolveActor: async () => ({
          ownerId: '22222222-2222-4222-8222-222222222222',
          sessionId: null,
          displayName: 'History owner',
          timezoneId: null,
        }),
      });
      expect(res.status).toBe(503);
      expect(errorCode(body())).toBe('NOT_READY');
      expect(res.resHeaders['cache-control']).toBe('no-store');
    }
  });

  it('GET /auth/status without a database returns503 and no-store, never missing route or empty setup', async () => {
    const { req, res, body } = fakePair('GET', '/api/v1/auth/status');
    await handleRequest(req, res, { pool: null, tzdbVersion: '2024a' });
    expect(res.status).toBe(503);
    expect(errorCode(body())).toBe('NOT_READY');
    expect(res.resHeaders['cache-control']).toBe('no-store');
  });

  it('unknown auth methods and library routes are404 even without database or Origin', async () => {
    for (const [method, path] of [
      ['PUT', '/api/v1/auth/status'],
      ['GET', '/api/v1/auth/sign-in'],
      ['POST', '/api/v1/auth/sign-up/email'],
    ]) {
      const { req, res, body } = fakePair(method!, path!);
      await handleRequest(req, res, { pool: null, tzdbVersion: '2024a' });
      expect(res.status).toBe(404);
      expect(errorCode(body())).toBe('NOT_FOUND');
      expect(res.resHeaders['cache-control']).toBe('no-store');
    }
  });

  it('preserves feature-specific authentication and errors on route misses', async () => {
    const actor = {
      ownerId: '22222222-2222-4222-8222-222222222222',
      sessionId: null,
      displayName: '',
      timezoneId: null,
    };
    for (const [method, path, authenticated, status, message] of [
      ['GET', '/api/v1/approvals/no/such/path', false, 401, null],
      ['PUT', '/api/v1/approvals/no/such/path', false, 401, null],
      ['PUT', '/api/v1/tasks/no/such/path', false, 404, 'not found'],
      ['GET', '/api/v1/conversations/no/runs/no/actions/pause', false, 401, null],
      ['GET', '/api/v1/conversations/no/runs/no/actions/pause', true, 404, 'Run not found'],
      [
        'GET',
        '/api/v1/document-approvals/%61/actions/confirm',
        true,
        404,
        'document approval not found',
      ],
      ['GET', '/api/v1/memories/no/actions/correct', true, 503, 'memory unavailable'],
      ['PUT', '/api/v1/workspaces', true, 404, 'route not found'],
      ['GET', '/api/v1/%6de', false, 404, 'not found'],
    ] as const) {
      const { req, res, body } = fakePair(method, path);
      await handleRequest(req, res, {
        pool: null,
        resolveActor: async () => (authenticated ? actor : null),
      });
      expect(res.status).toBe(status);
      expect(res.resHeaders['cache-control']).toBe('no-store');
      if (message) expect(body().msg).toBe(message);
    }
  });

  it('resolver failures before business write guards are503 rather than uncaught or401', async () => {
    const { req, res, body } = fakePair('POST', '/api/v1/conversations/messages');
    await handleRequest(req, res, {
      pool: null,
      tzdbVersion: '2024a',
      resolveActor: async () => {
        throw new Error('database offline');
      },
    });
    expect(res.status).toBe(503);
    expect(errorCode(body())).toBe('NOT_READY');
  });

  it('GET /readyz without TZDB_VERSION returns typed 503', async () => {
    const { req, res, body } = fakePair('GET', '/readyz');
    await handleRequest(req, res, { pool: null });
    expect(res.status).toBe(503);
    expect(body()).toEqual({
      status: 'not_ready',
      reason: 'TZDB_UNAVAILABLE',
      details: { missing: ['TZDB_VERSION'] },
    });
  });

  it('GET /readyz requires matching actual rules and a reachable DB', async () => {
    const { req, res, body } = fakePair('GET', '/readyz');
    const pool = { query: async () => ({ rows: [{ '?column?': 1 }] }) } as unknown as Pool;
    await handleRequest(req, res, { tzdbVersion: 'fixture-v1', pool });
    expect(res.status).toBe(200);
    expect(body()).toEqual({ status: 'ok' });
  });

  it('GET /readyz rejects an arbitrary nonempty version', async () => {
    const { req, res, body } = fakePair('GET', '/readyz');
    await handleRequest(req, res, { pool: null, tzdbVersion: '2024a' });
    expect(res.status).toBe(503);
    expect(body()).toEqual({ status: 'not_ready', reason: 'TZDB_UNAVAILABLE' });
  });

  it('DB failure only changes readiness, not liveness', async () => {
    const pool = {
      query: async () => {
        throw new Error('connection refused');
      },
    } as unknown as Pool;
    for (const path of ['/readyz', '/healthz']) {
      const { req, res, body } = fakePair('GET', path);
      await handleRequest(req, res, { tzdbVersion: 'fixture-v1', pool });
      expect(res.status).toBe(path === '/readyz' ? 503 : 200);
      expect(body()).toEqual(
        path === '/readyz' ? { status: 'not_ready', reason: 'NOT_READY' } : { status: 'ok' },
      );
    }
  });

  it('bad actual rules take priority over an unavailable database', async () => {
    const { req, res, body } = fakePair('GET', '/readyz');
    await handleRequest(req, res, {
      pool: null,
      tzdbVersion: 'fixture-v1',
      timeContext: createTimeContext('fixture-v1', null, null),
    });
    expect(res.status).toBe(503);
    expect(body()).toEqual({ status: 'not_ready', reason: 'TZDB_UNAVAILABLE' });
  });

  it('guarded routes return 401 UNAUTHENTICATED envelope', async () => {
    for (const path of ['/api/v1/me', '/api/v1/brief']) {
      const { req, res, body } = fakePair('GET', path);
      await handleRequest(req, res, { pool: null, tzdbVersion: '2024a' });
      expect(res.status).toBe(401);
      const payload = body();
      expect(payload.code).toBe(401);
      expect(errorCode(payload)).toBe('UNAUTHENTICATED');
    }
  });

  it('unknown paths return 404', async () => {
    const { req, res } = fakePair('GET', '/nope');
    await handleRequest(req, res, { pool: null, tzdbVersion: '2024a' });
    expect(res.status).toBe(404);
  });

  it('propagates incoming request id', async () => {
    const { req, res, body } = fakePair('GET', '/healthz', { 'x-request-id': 'r-1' });
    await handleRequest(req, res, { pool: null });
    expect(res.resHeaders['x-request-id']).toBe('r-1');
    expect(body()).toEqual({ status: 'ok' });
  });

  it('malformed cookie percent-encoding returns 401, not 500', async () => {
    const { req, res, body } = fakePair('GET', '/api/v1/me', {
      cookie: 'better-auth.session_token=%E0%A4%A',
    });
    await handleRequest(req, res, { tzdbVersion: '2024a', pool: null });
    expect(res.status).toBe(401);
    expect(errorCode(body())).toBe('UNAUTHENTICATED');
  });

  it('read routes without actor return 401', async () => {
    for (const path of ['/api/v1/approvals', '/api/v1/tasks']) {
      const { req, res, body } = fakePair('GET', path);
      await handleRequest(req, res, { pool: null, tzdbVersion: '2024a' });
      expect(res.status).toBe(401);
      expect(errorCode(body())).toBe('UNAUTHENTICATED');
    }
  });

  it('read routes without pool return 503 NOT_READY under dev auth', async () => {
    process.env.ALLOW_DEV_AUTH = '1';
    process.env.DEV_OWNER_ID = '00000000-0000-0000-0000-000000000001';
    try {
      for (const path of ['/api/v1/approvals', '/api/v1/tasks']) {
        const { req, res, body } = fakePair('GET', path);
        await handleRequest(req, res, { pool: null, tzdbVersion: '2024a' });
        expect(res.status).toBe(503);
        expect(errorCode(body())).toBe('NOT_READY');
      }
    } finally {
      delete process.env.ALLOW_DEV_AUTH;
      delete process.env.DEV_OWNER_ID;
    }
  });
});
