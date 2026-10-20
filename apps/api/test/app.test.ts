import { describe, expect, it } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../src/http/app.js';

interface FakeResponse extends ServerResponse {
  status: number;
  resHeaders: Record<string, string>;
  payload: string;
}

function fakePair(method: string, url: string, headers: Record<string, string> = {}) {
  const req = { method, url, headers } as unknown as IncomingMessage;
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
  it('GET /healthz returns 200 without env/DB', async () => {
    const { req, res, body } = fakePair('GET', '/healthz');
    await handleRequest(req, res, { tzdbVersion: undefined });
    expect(res.status).toBe(200);
    expect(body()).toEqual({ status: 'ok' });
  });

  it('GET /readyz without TZDB_VERSION returns typed 503', async () => {
    const { req, res, body } = fakePair('GET', '/readyz');
    await handleRequest(req, res, { tzdbVersion: undefined });
    expect(res.status).toBe(503);
    expect(body()).toEqual({
      status: 'not_ready',
      reason: 'TZDB_UNAVAILABLE',
      details: { missing: ['TZDB_VERSION'] },
    });
  });

  it('GET /readyz with TZDB_VERSION returns 200', async () => {
    const { req, res } = fakePair('GET', '/readyz');
    await handleRequest(req, res, { tzdbVersion: '2024a' });
    expect(res.status).toBe(200);
  });

  it('guarded routes return 401 UNAUTHENTICATED envelope', async () => {
    for (const path of ['/api/v1/me', '/api/v1/brief']) {
      const { req, res, body } = fakePair('GET', path);
      await handleRequest(req, res, { tzdbVersion: '2024a' });
      expect(res.status).toBe(401);
      const payload = body();
      expect(payload.code).toBe(401);
      expect(errorCode(payload)).toBe('UNAUTHENTICATED');
    }
  });

  it('unknown paths return 404', async () => {
    const { req, res } = fakePair('GET', '/nope');
    await handleRequest(req, res, { tzdbVersion: '2024a' });
    expect(res.status).toBe(404);
  });

  it('propagates incoming request id', async () => {
    const { req, res, body } = fakePair('GET', '/healthz', { 'x-request-id': 'r-1' });
    await handleRequest(req, res, { tzdbVersion: undefined });
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
      await handleRequest(req, res, { tzdbVersion: '2024a' });
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
        await handleRequest(req, res, { tzdbVersion: '2024a' });
        expect(res.status).toBe(503);
        expect(errorCode(body())).toBe('NOT_READY');
      }
    } finally {
      delete process.env.ALLOW_DEV_AUTH;
      delete process.env.DEV_OWNER_ID;
    }
  });
});
