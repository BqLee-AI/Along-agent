import { EnvelopeSchema } from '@along/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { handleRequest } from '../../src/http/app.js';
import { isActiveOwner } from '../../src/modules/identity/preferences.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const suite = databaseUrl ? describe : describe.skip;
suite('invited-account public admission and dependency boundaries', () => {
  let database: IntegrationDatabase;
  let server: Server;
  let base: string;
  beforeEach(async () => {
    database = await createIntegrationDatabase();
    server = createServer((req, res) => {
      void handleRequest(req, res, { pool: database.pool, tzdbVersion: '2024a' });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await database?.close();
  });

  it('does not grant business admission merely because a historical user is active', async () => {
    const userId = randomUUID();
    await database.pool.query('INSERT INTO users(id,auth_email) VALUES($1,$2)', [
      userId,
      `${userId}@local.invalid`,
    ]);
    const client = await database.pool.connect();
    try {
      expect(await isActiveOwner(client, userId)).toBe(false);
    } finally {
      client.release();
    }
  });

  it('requires a signed actor at the new account read surface rather than exposing another owner', async () => {
    const response = await fetch(`${base}/api/v1/auth/account`);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('fails unavailable mail configuration accurately rather than pretending an anonymous request was sent', async () => {
    const response = await fetch(`${base}/api/v1/auth/password/forgot`, {
      method: 'POST',
      headers: {
        origin: process.env.APP_ORIGIN ?? 'http://localhost:3000',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'recipient@example.com' }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    const body = EnvelopeSchema.parse(await response.json());
    expect(body.error?.code).toBe('NOT_READY');
  });

  it('charges invalid token syntax before validation and publishes the durable quota boundary', async () => {
    for (let attempt = 0; attempt <= 10; attempt += 1) {
      const response = await fetch(`${base}/api/v1/auth/invitations/accept`, {
        method: 'POST',
        headers: {
          origin: process.env.APP_ORIGIN ?? 'http://localhost:3000',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          token: 'invalid-format',
          login_name: 'invitee',
          password: 'Invitee-Passphrase-112',
          display_name: 'Invitee',
        }),
      });
      if (attempt < 10) {
        expect(response.status).toBe(400);
        await response.arrayBuffer();
      } else {
        expect(response.status).toBe(429);
        expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(EnvelopeSchema.parse(await response.json()).error?.code).toBe('RATE_LIMITED');
      }
    }
  });
});
