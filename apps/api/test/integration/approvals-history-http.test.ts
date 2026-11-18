import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { ApprovalDetailSchema, EnvelopeSchema } from '@along/contracts';
import { handleRequest } from '../helpers/http-app.js';
import { seedAdmittedSession as seedSession } from './setup.js';
import { confirmApproval } from '../../src/features/approvals/reminder/confirm.js';
import { getApprovalDetail } from '../../src/features/approvals/reminder/service.js';
import { createIntegrationDatabase, databaseUrl, seedApproval } from './setup.js';
import type { IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;

maybe('task approval history HTTP consumer', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
    server = createServer((req, res) => {
      void handleRequest(req, res, { pool, tzdbVersion: '2024a' });
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing HTTP address');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await database?.close();
  });

  it('returns the real result with the shared strict DTO and owner/no-store boundaries', async () => {
    const owner = await seedSession(pool);
    const outsider = await seedSession(pool);
    const seed = await seedApproval(pool, { ownerId: owner.userId });
    const { detail } = await getApprovalDetail({ pool }, owner.userId, seed.id);
    const consumed = await confirmApproval({ pool }, owner.userId, seed.id, {
      presentation_hash: detail.presentation_hash,
      seen_content: detail.echo_text,
      idempotency_key: randomUUID(),
    });
    const url = `${origin}/api/v1/approvals/${seed.id}`;
    const response = await fetch(url, {
      headers: { cookie: `better-auth.session_token=${owner.token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const envelope = EnvelopeSchema.parse(await response.json());
    expect(ApprovalDetailSchema.parse(envelope.data)).toMatchObject({
      approval_id: seed.id,
      status: 'consumed',
      result: { task_id: consumed.task_id, successor_approval_id: null },
    });

    for (const [path, cookie, status, code] of [
      [url, outsider.token, 403, 'FORBIDDEN'],
      [`${origin}/api/v1/approvals/${randomUUID()}`, owner.token, 404, 'NOT_FOUND'],
      [`${origin}/api/v1/approvals/not-a-uuid`, owner.token, 404, 'NOT_FOUND'],
      [url, '', 401, 'UNAUTHENTICATED'],
    ] as const) {
      const denied = await fetch(path, {
        headers: cookie ? { cookie: `better-auth.session_token=${cookie}` } : {},
      });
      expect(denied.status).toBe(status);
      expect(denied.headers.get('cache-control')).toBe('no-store');
      const failure = EnvelopeSchema.parse(await denied.json());
      expect(failure.data).toBeNull();
      expect(failure.error?.code).toBe(code);
    }
  });

  it('does not turn a missing consumed task result into an HTTP success', async () => {
    const owner = await seedSession(pool);
    const seed = await seedApproval(pool, { ownerId: owner.userId, state: 'consumed' });
    const response = await fetch(`${origin}/api/v1/approvals/${seed.id}`, {
      headers: { cookie: `better-auth.session_token=${owner.token}` },
    });
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const envelope = EnvelopeSchema.parse(await response.json());
    expect(envelope.data).toBeNull();
    expect(envelope.error?.code).toBe('STATE_CONFLICT');
  });
});
