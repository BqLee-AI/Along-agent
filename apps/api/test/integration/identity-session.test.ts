import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { handleRequest } from '../../src/http/app.js';
import { createAuth } from '../../src/modules/identity/better-auth.js';
import { databaseUrl, requirePool, seedApproval } from './setup.js';
import { seedSession } from '../../src/modules/identity/seed.js';
import { getApprovalDetail } from '../../src/modules/approvals/service.js';
const maybe = databaseUrl ? describe : describe.skip;

interface FakeResponse extends ServerResponse {
  status: number;
  resHeaders: Record<string, string>;
  payload: string;
}

function fakeGet(url: string, headers: Record<string, string> = {}) {
  const req = { method: 'GET', url, headers } as unknown as IncomingMessage;
  const res = {
    status: 0,
    resHeaders: {} as Record<string, string>,
    payload: '',
    writeHead(status: number, resHeaders: Record<string, string>) {
      const self = this as unknown as FakeResponse;
      self.status = status;
      self.resHeaders = resHeaders;
    },
    end(body: string) {
      (this as unknown as FakeResponse).payload = body;
    },
  } as unknown as FakeResponse;
  return { req, res, body: () => JSON.parse(res.payload) as Record<string, unknown> };
}

function fakePost(url: string, headers: Record<string, string>, payload: unknown) {
  const emitter = new EventEmitter();
  const req = Object.assign(emitter, {
    method: 'POST',
    url,
    headers,
  }) as unknown as IncomingMessage;
  const res = {
    status: 0,
    resHeaders: {} as Record<string, string>,
    payload: '',
    writeHead(status: number, resHeaders: Record<string, string>) {
      const self = this as unknown as FakeResponse;
      self.status = status;
      self.resHeaders = resHeaders;
    },
    end(body: string) {
      (this as unknown as FakeResponse).payload = body;
    },
  } as unknown as FakeResponse;
  setImmediate(() => {
    emitter.emit('data', Buffer.from(JSON.stringify(payload), 'utf8'));
    emitter.emit('end');
  });
  return { req, res, body: () => JSON.parse(res.payload) as Record<string, unknown> };
}

function errorOf(payload: Record<string, unknown>): { code: unknown; details: unknown } {
  const error = payload.error as { code: unknown; details?: unknown };
  return { code: error.code, details: error.details };
}

maybe('identity session + /me + CSRF', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = requirePool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it('GET /me returns the actor snapshot with CSRF token and no-store', async () => {
    const seeded = await seedSession(pool, { timezoneId: 'Asia/Shanghai' });
    const { req, res, body } = fakeGet('/api/v1/me', {
      cookie: `better-auth.session_token=${seeded.token}`,
    });
    await handleRequest(req, res, { pool, tzdbVersion: '2024a' });
    expect(res.status).toBe(200);
    expect(res.resHeaders['cache-control']).toBe('no-store');
    const payload = body();
    expect(payload.code).toBe(0);
    const data = payload.data as Record<string, unknown>;
    expect(data.user).toMatchObject({ id: seeded.userId });
    expect(typeof data.csrf_token).toBe('string');
    expect(data.csrf_token).toBe(seeded.csrfToken);
    expect(data.confirmed_timezone).toBe('Asia/Shanghai');
  });

  it('GET /me without a session returns the 401 envelope', async () => {
    const { req, res, body } = fakeGet('/api/v1/me');
    await handleRequest(req, res, { pool, tzdbVersion: '2024a' });
    expect(res.status).toBe(401);
    const payload = body();
    expect(payload.code).toBe(401);
    expect(errorOf(payload).code).toBe('UNAUTHENTICATED');
  });

  it('expired, revoked, and disabled sessions return 401', async () => {
    // Expired fixture: backdate created+expires together so the
    // sessions_expiry_check (expires_at > created_at) still holds.
    const expiredBase = await seedSession(pool, {});
    await pool.query(
      "UPDATE sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = $1",
      [expiredBase.sessionId],
    );
    const revoked = await seedSession(pool, {});
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [revoked.sessionId]);
    const disabled = await seedSession(pool, {});
    await pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [disabled.userId]);
    for (const token of [expiredBase.token, revoked.token, disabled.token]) {
      const { req, res } = fakeGet('/api/v1/me', {
        cookie: `better-auth.session_token=${token}`,
      });
      await handleRequest(req, res, { pool, tzdbVersion: '2024a' });
      expect(res.status).toBe(401);
    }
  });

  it('POST confirm without CSRF returns 403 CSRF_MISMATCH; with token it succeeds', async () => {
    const seeded = await seedSession(pool, {});
    const approval = await seedApproval(pool, { ownerId: seeded.userId });
    const { detail } = await getApprovalDetail({ pool }, seeded.userId, approval.id);
    const payload = {
      presentation_hash: approval.presentationHash,
      seen_content: detail.echo_text,
      idempotency_key: randomUUID(),
    };
    const cookie = { cookie: `better-auth.session_token=${seeded.token}` };

    const denied = fakePost(`/api/v1/approvals/${approval.id}/actions/confirm`, cookie, payload);
    await handleRequest(denied.req, denied.res, { pool, tzdbVersion: '2024a' });
    expect(denied.res.status).toBe(403);
    expect(errorOf(denied.body()).code).toBe('FORBIDDEN');
    expect(errorOf(denied.body()).details).toMatchObject({ reason: 'CSRF_MISMATCH' });

    const allowed = fakePost(
      `/api/v1/approvals/${approval.id}/actions/confirm`,
      { ...cookie, 'x-csrf-token': seeded.csrfToken },
      payload,
    );
    await handleRequest(allowed.req, allowed.res, { pool, tzdbVersion: '2024a' });
    expect(allowed.res.status).toBe(200);
    expect((allowed.body().data as Record<string, unknown>).approval_id).toBe(approval.id);
  });

  it('better-auth getSession resolves through the pg adapter chain', async () => {
    const seeded = await seedSession(pool, {});
    const auth = createAuth(pool);
    expect(auth).not.toBeNull();
    if (!auth) return;
    const headers = new Headers({
      cookie: `better-auth.session_token=${seeded.token}`,
    });
    const result = await auth.api.getSession({ headers });
    expect(result?.user?.id).toBe(seeded.userId);
    // Unknown tokens resolve to null, not throw.
    const miss = await auth.api.getSession({
      headers: new Headers({ cookie: 'better-auth.session_token=nope' }),
    });
    expect(miss).toBeNull();
  });
});
