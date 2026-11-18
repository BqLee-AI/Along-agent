import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { handleRequest } from '../helpers/http-app.js';
import type { AppDeps } from '../../src/http/contracts.js';
import { loadTimeContext, createTimeContext } from '../../src/features/time/context.js';
import { seedAdmittedSession as seedSession } from './setup.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedApproval,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const input = { raw_text: '2027-11-02 09:20 喝水', confirmed_timezone: 'Asia/Shanghai' };

async function readChildLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let line = '';
  try {
    while (!line.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('API child exited before its checkpoint');
      line += new TextDecoder().decode(chunk.value);
    }
    return line.split('\n')[0];
  } finally {
    reader.releaseLock();
  }
}

async function startChild(database: IntegrationDatabase, drop: boolean) {
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL('./approvals-revise-server.ts', import.meta.url))],
    {
      env: {
        ...process.env,
        DATABASE_URL: database.connectionString,
        ALLOW_DEV_AUTH: '0',
        DROP_REVISION_RESPONSE: drop ? '1' : '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const { port } = JSON.parse(await readChildLine(child.stdout));
  return { child, base: `http://127.0.0.1:${port}` };
}

maybe('approval revise real session HTTP', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });

  it('strict boundaries and unavailable rules create no reservation; frozen reads and actions stay available', async () => {
    const session = await seedSession(pool, {});
    const old = await seedApproval(pool, { ownerId: session.userId });
    const other = await seedApproval(pool, {});
    const deps: AppDeps = {
      pool,
      timeContext: createTimeContext('fixture-v1', null, null),
      tzdbVersion: 'fixture-v1',
    };
    const server = createServer((req, res) => {
      void handleRequest(req, res, deps);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = {
      cookie: `better-auth.session_token=${session.token}`,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    };
    try {
      for (const [id, body, requestHeaders, status, code] of [
        [
          old.id,
          { ...input, idempotency_key: randomUUID() },
          { 'content-type': 'application/json' },
          401,
          'UNAUTHENTICATED',
        ],
        [
          old.id,
          { ...input, idempotency_key: randomUUID() },
          { cookie: headers.cookie, 'content-type': 'application/json' },
          403,
          'FORBIDDEN',
        ],
        ['not-a-uuid', {}, headers, 404, 'NOT_FOUND'],
        [
          old.id,
          { ...input, idempotency_key: randomUUID(), patch: {} },
          headers,
          400,
          'VALIDATION_ERROR',
        ],
        [other.id, { ...input, idempotency_key: randomUUID() }, headers, 403, 'FORBIDDEN'],
        [old.id, { ...input, idempotency_key: randomUUID() }, headers, 503, 'TZDB_UNAVAILABLE'],
      ] as const) {
        const response = await fetch(`${base}/api/v1/approvals/${id}/actions/revise`, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ data: null, error: { code } });
      }
      expect(
        (
          await pool.query('SELECT * FROM approval_revision_requests WHERE owner_id=$1', [
            session.userId,
          ])
        ).rows,
      ).toHaveLength(0);
      const detailResponse = await fetch(`${base}/api/v1/approvals/${old.id}`, { headers });
      expect(detailResponse.status).toBe(200);
      const { data: detail } = (await detailResponse.json()) as {
        data: { presentation_hash: string; echo_text: string };
      };
      const confirmed = await fetch(`${base}/api/v1/approvals/${old.id}/actions/confirm`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          presentation_hash: detail.presentation_hash,
          seen_content: detail.echo_text,
          idempotency_key: randomUUID(),
        }),
      });
      expect(confirmed.status).toBe(200);
      const rejected = await seedApproval(pool, { ownerId: session.userId });
      expect(
        (
          await fetch(`${base}/api/v1/approvals/${rejected.id}/actions/reject`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ idempotency_key: randomUUID() }),
          })
        ).status,
      ).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('real committed response loss and API process restart replay original result on a new fixture-bound pool', async () => {
    const session = await seedSession(pool, {});
    const old = await seedApproval(pool, { ownerId: session.userId });
    const body = { ...input, idempotency_key: randomUUID() };
    const headers = {
      cookie: `better-auth.session_token=${session.token}`,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    };
    const first = await startChild(database, true);
    const controller = new AbortController();
    try {
      const reply = fetch(`${first.base}/api/v1/approvals/${old.id}/actions/revise`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then((response) => response.json())
        .then(
          (data) => ({ kind: 'reply', data }),
          (error: unknown) => ({ kind: 'lost', error }),
        );
      expect(JSON.parse(await readChildLine(first.child.stdout))).toEqual({
        stage: 'revision_committed',
      });
      controller.abort();
      expect(await reply).toMatchObject({ kind: 'lost', error: { name: 'AbortError' } });
    } finally {
      controller.abort();
      first.child.kill();
      await first.child.exited;
    }
    const request = (
      await pool.query(
        'SELECT * FROM approval_revision_requests WHERE owner_id=$1 AND idempotency_key=$2',
        [old.ownerId, body.idempotency_key],
      )
    ).rows[0];
    expect(request.successor_approval_id).not.toBeNull();
    const second = await startChild(database, false);
    try {
      const response = await fetch(`${second.base}/api/v1/approvals/${old.id}/actions/revise`, {
        method: 'POST',
        headers: { ...headers, 'x-request-id': 'restart-replay' },
        body: JSON.stringify({
          idempotency_key: body.idempotency_key,
          fold_choice: 'none',
          confirmed_timezone: body.confirmed_timezone,
          raw_text: body.raw_text,
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        code: 0,
        data: {
          approval_id: old.id,
          successor_approval_id: request.successor_approval_id,
          duplicate: true,
        },
        msg: 'ok',
        error: null,
        request_id: 'restart-replay',
      });
      expect(
        (await pool.query('SELECT id FROM approvals WHERE supersedes_approval_id=$1', [old.id]))
          .rows,
      ).toHaveLength(1);
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM tasks WHERE owner_id=$1', [old.ownerId]))
          .rows[0].n,
      ).toBe(0);
    } finally {
      second.child.kill();
      await second.child.exited;
    }
  }, 20000);

  it('real HTTP typed candidates pass through and unknown DB errors stay sanitized with no half-chain', async () => {
    const session = await seedSession(pool, {});
    const old = await seedApproval(pool, { ownerId: session.userId });
    const deps: AppDeps = {
      pool,
      timeContext: loadTimeContext('fixture-v1'),
      tzdbVersion: 'fixture-v1',
    };
    const server = createServer((req, res) => {
      void handleRequest(req, res, deps);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = {
      cookie: `better-auth.session_token=${session.token}`,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    };
    try {
      const ambiguous = await fetch(`${base}/api/v1/approvals/${old.id}/actions/revise`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          raw_text: '2026-11-01 01:30 喝水',
          confirmed_timezone: 'America/New_York',
          idempotency_key: randomUUID(),
        }),
      });
      expect(ambiguous.status).toBe(422);
      expect(await ambiguous.json()).toMatchObject({
        code: 400005,
        error: {
          code: 'AMBIGUOUS_LOCAL_TIME',
          details: {
            wall_time: '2026-11-01T01:30:00',
            timezone_id: 'America/New_York',
            ruleset_id: 'FIXTURE_V1',
            candidates: [
              { fold_choice: 'first', offset_seconds: -14400, fire_at_utc: '2026-11-01T05:30:00Z' },
              {
                fold_choice: 'second',
                offset_seconds: -18000,
                fire_at_utc: '2026-11-01T06:30:00Z',
              },
            ],
          },
        },
      });
      await pool.query(
        `CREATE FUNCTION revision_http_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.supersedes_approval_id='${old.id}'::uuid THEN RAISE EXCEPTION 'private SQL details'; END IF; RETURN NEW; END $$; CREATE TRIGGER revision_http_fault BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION revision_http_fault()`,
      );
      try {
        const failed = await fetch(`${base}/api/v1/approvals/${old.id}/actions/revise`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...input, idempotency_key: randomUUID() }),
        });
        expect(failed.status).toBe(500);
        const payload = await failed.json();
        expect(payload).toMatchObject({ code: 500, data: null, error: { code: 'INTERNAL_ERROR' } });
        expect(JSON.stringify(payload)).not.toContain('private SQL');
        expect(
          (await pool.query('SELECT state FROM approvals WHERE id=$1', [old.id])).rows[0].state,
        ).toBe('pending');
        expect(
          (await pool.query('SELECT id FROM approvals WHERE supersedes_approval_id=$1', [old.id]))
            .rows,
        ).toHaveLength(0);
      } finally {
        await pool.query(
          'DROP TRIGGER revision_http_fault ON approvals; DROP FUNCTION revision_http_fault()',
        );
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
