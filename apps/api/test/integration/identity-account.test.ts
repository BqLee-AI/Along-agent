import { expectApplicationRejection } from '../helpers/application-error.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createServer, request, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { z } from 'zod';
import { EnvelopeSchema } from '@along/contracts';
import type { Envelope } from '@along/contracts';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedApproval,
  type IntegrationDatabase,
} from './setup.js';
import { type AccountService } from '../../src/features/identity/public.js';
import { createConfiguredAccountService } from '../../src/bootstrap/identity.js';
import { createAuth } from '../../src/features/identity/session/better-auth.js';
import { seedSession } from '../../src/features/identity/session/seed.js';
import {
  deriveAuthEmail,
  hashSessionToken,
  verifySignedCookieValue,
} from '../../src/features/identity/session/crypto.js';
import { handleRequest } from '../helpers/http-app.js';

const maybe = databaseUrl ? describe : describe.skip;
const origin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
const secret = process.env.BETTER_AUTH_SECRET;
const fields = {
  login_name: ' Original Admin ',
  password: 'a preserved password ',
  display_name: 'Administrator',
};
const unconfigured = async () => ({ state: 'unconfigured' as const, ownerIds: [] as string[] });
const signedMeSchema = EnvelopeSchema.extend({
  data: z.object({ user: z.object({ id: z.string().uuid() }), csrf_token: z.string() }),
});
function sessionCookie(cookies: string[]): string {
  return cookies.map((value) => value.split(';')[0]).join('; ');
}

function publicFailure(payload: unknown): Envelope {
  const body = EnvelopeSchema.parse(payload);
  return {
    ...body,
    request_id: '',
    error: body.error ? { ...body.error, request_id: '' } : body.error,
  };
}

maybe('R1 account application service and public HTTP', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  let service: AccountService;
  let server: Server | undefined;
  let base: string;
  beforeEach(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
    service = createConfiguredAccountService(pool, {
      secret,
      origin,
      workspaceStatus: unconfigured,
    });
  });
  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
    await database?.close();
  });
  async function listen(): Promise<void> {
    server = createServer((req, res) => {
      void handleRequest(req, res, { pool, accountService: service, tzdbVersion: '2024a' });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${base}/api/v1/auth/${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }
  async function counts(): Promise<number[]> {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM auth_accounts) AS accounts,(SELECT count(*)::int FROM sessions) AS sessions,(SELECT count(*)::int FROM installation_admin) AS admins`,
    );
    return [rows[0].users, rows[0].accounts, rows[0].sessions, rows[0].admins];
  }

  it('confirms empty state, commits one account and library Cookie; /me keeps fixed lifetime and leaks no secrets', async () => {
    await listen();
    expect(await service.status()).toEqual({ state: 'setup_required' });
    const response = await post('initialize', fields);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload = EnvelopeSchema.parse(await response.json());
    expect(payload.data).toEqual({
      authenticated: true,
      workspace_binding: 'pending_local_configuration',
    });
    expect(JSON.stringify(payload)).not.toMatch(/token|hash|auth_email/);
    const cookie = sessionCookie(response.headers.getSetCookie());
    const signed = decodeURIComponent(cookie.split('; ')[0]!.split('=').slice(1).join('='));
    const token = verifySignedCookieValue(signed, secret);
    expect(token).toBeTruthy();
    const user = await service.getBoundAdministrator();
    const { rows: sessions } = await pool.query('SELECT * FROM sessions WHERE user_id=$1', [
      user!.userId,
    ]);
    expect(sessions[0].token_hash).toBe(hashSessionToken(token!, secret));
    expect(sessions[0].token_hash).not.toBe(token);
    // Better Auth samples expiry and creation using adjacent clock reads.
    const lifetime = sessions[0].expires_at.getTime() - sessions[0].created_at.getTime();
    expect(lifetime).toBeLessThanOrEqual(604800000);
    expect(lifetime).toBeGreaterThan(604799000);
    const before = JSON.stringify(sessions[0]);
    for (let index = 0; index < 2; index++) {
      const me = await fetch(`${base}/api/v1/me`, { headers: { cookie } });
      expect(me.status).toBe(200);
      expect(signedMeSchema.parse(await me.json()).data.user.id).toBe(user!.userId);
    }
    expect(
      JSON.stringify(
        (await pool.query('SELECT * FROM sessions WHERE id=$1', [sessions[0].id])).rows[0],
      ),
    ).toBe(before);
    expect(await counts()).toEqual([1, 1, 1, 1]);
    await expect(seedSession(pool)).rejects.toThrow('administrator bound');
    await expectApplicationRejection(service.initialize(fields), { status: 409 });
  });

  it('serializes two independent connection initializers with exactly one complete winner', async () => {
    const second = database.connect();
    try {
      const results = await Promise.allSettled([
        service.initialize(fields),
        createConfiguredAccountService(second, {
          secret,
          origin,
          workspaceStatus: unconfigured,
        }).initialize({
          ...fields,
          login_name: 'other',
        }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await counts()).toEqual([1, 1, 1, 1]);
    } finally {
      await second.end();
    }
  });

  for (const table of ['users', 'auth_accounts', 'sessions', 'installation_admin']) {
    it(`rolls back every account fact on real ${table} insert failure`, async () => {
      await pool.query(
        `CREATE FUNCTION account_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'account write fault'; END $$; CREATE TRIGGER account_test_fault BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION account_test_fault()`,
      );
      await expectApplicationRejection(service.initialize(fields), { status: 503 });
      const independent = database.connect();
      try {
        expect((await independent.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
      } finally {
        await independent.end();
      }
      expect(await counts()).toEqual([0, 0, 0, 0]);
    });
  }

  it('publishes no Cookie when PG rejects deferred commit and rolls everything back', async () => {
    await pool.query(
      `CREATE FUNCTION account_commit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deferred commit fault'; END $$; CREATE CONSTRAINT TRIGGER account_commit_fault AFTER INSERT ON installation_admin DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION account_commit_fault()`,
    );
    await listen();
    const response = await post('initialize', fields);
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await counts()).toEqual([0, 0, 0, 0]);
  });

  it('keeps committed identity when commit acknowledgement is lost without publishing success', async () => {
    const uncertain = new Proxy(pool, {
      get(target, property) {
        if (property === 'connect')
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, key) {
                if (key === 'query')
                  return async (sql: string, values?: unknown[]) => {
                    const result = await connection.query(sql, values);
                    if (sql === 'COMMIT') throw new Error('injected lost commit acknowledgement');
                    return result;
                  };
                const value = Reflect.get(connection, key);
                return typeof value === 'function' ? value.bind(connection) : value;
              },
            });
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expectApplicationRejection(
      createConfiguredAccountService(uncertain, {
        secret,
        origin,
        workspaceStatus: unconfigured,
      }).initialize(fields),
      { status: 503 },
    );
    expect(await service.status()).toEqual({ state: 'ready' });
    expect(await counts()).toEqual([1, 1, 1, 1]);
    await expectApplicationRejection(service.initialize(fields), { status: 409 });
  });

  it('provides a genuine library factory transaction with rollback visible from an independent pool', async () => {
    const context = await createAuth(pool)!.$context;
    await expect(
      context.adapter.transaction(async (adapter) => {
        await adapter.create({
          model: 'user',
          data: {
            name: 'Uncommitted',
            email: `${randomUUID()}@local.invalid`,
            emailVerified: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        throw new Error('injected after library write');
      }),
    ).rejects.toThrow('injected after library write');
    const independent = database.connect();
    try {
      expect((await independent.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(0);
    } finally {
      await independent.end();
    }
  });

  it('loaded registration without users closes anonymous setup instead of assuming an empty installation', async () => {
    const registered = createConfiguredAccountService(pool, {
      secret,
      origin,
      workspaceStatus: async () => ({ state: 'loaded', ownerIds: [] }),
    });
    expect(await registered.status()).toEqual({ state: 'legacy_claim_required' });
    await expectApplicationRejection(registered.initialize(fields), { status: 409 });
    expect(await counts()).toEqual([0, 0, 0, 0]);
  });

  it('creates a missing credential only for the explicitly selected old user, and refuses login name collisions', async () => {
    const original = await seedSession(pool, { displayName: 'No credential' });
    const other = await seedSession(pool, { displayName: 'Other login' });
    await pool.query('DELETE FROM auth_accounts WHERE user_id=$1', [original.userId]);
    await pool.query('UPDATE users SET auth_email=$1 WHERE id=$2', [
      deriveAuthEmail('occupied', secret),
      other.userId,
    ]);
    await expectApplicationRejection(
      service.claim(original.userId, {
        login_name: 'occupied',
        password: fields.password,
        confirmed: true,
      }),
      { status: 409 },
    );
    const selected = (await service.listMaintenanceCandidates()).find(
      (candidate) => candidate.displayName === 'No credential',
    )!;
    await service.bindLocal({
      selection: selected.selection,
      confirmed: true,
      loginName: 'new-name',
      password: fields.password,
    });
    const credential = (
      await pool.query('SELECT user_id,account_id FROM auth_accounts WHERE user_id=$1', [
        original.userId,
      ])
    ).rows;
    expect(credential).toEqual([{ user_id: original.userId, account_id: original.userId }]);
    expect((await service.getBoundAdministrator())!.userId).toBe(original.userId);
  });

  it('does not initialize over orphan business owners or invalid/unreadable registries', async () => {
    await seedApproval(pool, { ownerId: randomUUID() });
    await expectApplicationRejection(service.status(), { status: 503 });
    await expectApplicationRejection(service.initialize(fields), { status: 503 });
    expect(await counts()).toEqual([0, 0, 0, 0]);
    for (const state of ['invalid', 'unreadable'] as const) {
      const blocked = createConfiguredAccountService(pool, {
        secret,
        origin,
        workspaceStatus: async () => ({ state, ownerIds: [] }),
      });
      await expectApplicationRejection(blocked.status(), { status: 503 });
    }
  });

  it('preserves both legacy owners/history and old signed sessions; only current actor is claimed', async () => {
    const original = await seedSession(pool, { displayName: 'Original' });
    const other = await seedSession(pool, { displayName: 'Other' });
    const history = await seedApproval(pool, { ownerId: original.userId });
    const untouched = JSON.stringify(
      (await pool.query('SELECT * FROM auth_accounts WHERE user_id=$1', [other.userId])).rows,
    );
    expect((await service.status()).state).toBe('legacy_claim_required');
    await expectApplicationRejection(service.initialize(fields), { status: 409 });
    const email = (await pool.query('SELECT auth_email FROM users WHERE id=$1', [original.userId]))
      .rows[0].auth_email;
    await expect(
      createAuth(pool)!.api.signInEmail({ body: { email, password: fields.password } }),
    ).rejects.toMatchObject({ status: 'UNAUTHORIZED' });
    await listen();
    const cookie = `better-auth.session_token=${original.token}`;
    const response = await post(
      'claim',
      { login_name: fields.login_name, password: fields.password, confirmed: true },
      { cookie, 'x-csrf-token': original.csrfToken },
    );
    expect(response.status).toBe(200);
    expect((await service.getBoundAdministrator())!.userId).toBe(original.userId);
    expect(
      (await pool.query('SELECT owner_id FROM approvals WHERE id=$1', [history.id])).rows[0]
        .owner_id,
    ).toBe(original.userId);
    expect(
      JSON.stringify(
        (await pool.query('SELECT * FROM auth_accounts WHERE user_id=$1', [other.userId])).rows,
      ),
    ).toBe(untouched);
    expect((await fetch(`${base}/api/v1/me`, { headers: { cookie } })).status).toBe(200);
    const account = (
      await pool.query('SELECT account_id,password_hash FROM auth_accounts WHERE user_id=$1', [
        original.userId,
      ])
    ).rows[0];
    expect(account.account_id).toBe(original.userId);
    expect(
      await (
        await createAuth(pool)!.$context
      ).password.verify({ hash: account.password_hash, password: fields.password }),
    ).toBe(true);
  });

  it('local selection is opaque and explicit; existing-password binding verifies rather than overwrites', async () => {
    const original = await seedSession(pool, { displayName: 'Selected original' });
    await seedSession(pool, { displayName: 'Do not select' });
    const context = await createAuth(pool)!.$context;
    const hash = await context.password.hash(fields.password);
    await pool.query('UPDATE auth_accounts SET account_id=$1,password_hash=$2 WHERE user_id=$1', [
      original.userId,
      hash,
    ]);
    const candidates = await service.listMaintenanceCandidates();
    expect(JSON.stringify(candidates)).not.toContain(original.userId);
    const selected = candidates.find((candidate) => candidate.displayName === 'Selected original')!;
    await expectApplicationRejection(
      service.bindLocal({
        selection: randomUUID(),
        confirmed: true,
        loginName: 'selected',
        password: fields.password,
      }),
      { status: 400 },
    );
    await expectApplicationRejection(
      service.claim(original.userId, {
        login_name: 'selected',
        password: 'replacement password',
        confirmed: true,
      }),
      { status: 409 },
    );
    await expectApplicationRejection(
      service.bindLocal({
        selection: selected.selection,
        confirmed: true,
        loginName: 'selected',
        password: 'wrong password',
      }),
      { status: 401 },
    );
    expect(
      await service.bindLocal({
        selection: selected.selection,
        confirmed: true,
        loginName: 'selected',
        password: fields.password,
      }),
    ).toEqual({ bound: true });
    expect((await service.getBoundAdministrator())!.userId).toBe(original.userId);
    expect(
      (
        await pool.query('SELECT password_hash FROM auth_accounts WHERE user_id=$1', [
          original.userId,
        ])
      ).rows[0].password_hash,
    ).toBe(hash);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n).toBe(2);
  });

  for (const conflict of ['disabled', 'inconsistent', 'password'] as const) {
    it(`refuses legacy ${conflict} without changing account or activating user`, async () => {
      const original = await seedSession(pool);
      if (conflict === 'disabled')
        await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [original.userId]);
      if (conflict === 'inconsistent')
        await pool.query("UPDATE auth_accounts SET account_id='wrong-owner' WHERE user_id=$1", [
          original.userId,
        ]);
      if (conflict === 'password')
        await pool.query(
          "UPDATE auth_accounts SET password_hash='existing-must-not-overwrite' WHERE user_id=$1",
          [original.userId],
        );
      const before = JSON.stringify(
        (
          await pool.query('SELECT * FROM auth_accounts WHERE user_id=$1 ORDER BY id', [
            original.userId,
          ])
        ).rows,
      );
      await expectApplicationRejection(
        service.claim(original.userId, {
          login_name: 'claimed',
          password: fields.password,
          confirmed: true,
        }),
        { status: 409 },
      );
      expect(await service.getBoundAdministrator()).toBeNull();
      expect(
        JSON.stringify(
          (
            await pool.query('SELECT * FROM auth_accounts WHERE user_id=$1 ORDER BY id', [
              original.userId,
            ])
          ).rows,
        ),
      ).toBe(before);
    });
  }

  it('returns indistinguishable login failures for wrong password, unbound, missing credential, and disabled; bound state stays ready', async () => {
    const other = await seedSession(pool, { displayName: 'Unbound' });
    const unbound = await seedSession(pool, { displayName: 'Must remain unbound' });
    const context = await createAuth(pool)!.$context;
    await pool.query('UPDATE users SET auth_email=$1 WHERE id=$2', [
      deriveAuthEmail('unbound', secret),
      unbound.userId,
    ]);
    await pool.query('UPDATE auth_accounts SET account_id=$1,password_hash=$2 WHERE user_id=$1', [
      unbound.userId,
      await context.password.hash(fields.password),
    ]);
    await service.claim(other.userId, {
      login_name: 'admin',
      password: fields.password,
      confirmed: true,
    });
    await listen();
    const bodies: Envelope[] = [];
    for (const credentials of [
      { login_name: 'missing', password: fields.password },
      { login_name: 'admin', password: 'wrong password' },
      { login_name: 'unbound', password: fields.password },
    ]) {
      const response = await post('sign-in', credentials);
      expect(response.status).toBe(401);
      bodies.push(publicFailure(await response.json()));
    }
    await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [other.userId]);
    const disabled = await post('sign-in', { login_name: 'admin', password: fields.password });
    expect(disabled.status).toBe(401);
    bodies.push(publicFailure(await disabled.json()));
    for (const failure of bodies) expect(failure).toEqual(bodies[0]);
    expect(await service.status()).toEqual({ state: 'ready' });
    await pool.query("UPDATE users SET status='active' WHERE id=$1", [other.userId]);
    await pool.query('DELETE FROM auth_accounts WHERE user_id=$1', [other.userId]);
    const missingCredential = await post('sign-in', {
      login_name: 'admin',
      password: fields.password,
    });
    expect(missingCredential.status).toBe(401);
    expect(publicFailure(await missingCredential.json())).toEqual(bodies[0]);
  });

  it('normal signout commits soft revocation without changing expiry; fault returns503, no clear Cookie and old session still resolves', async () => {
    const result = await service.initialize(fields);
    await listen();
    const cookie = sessionCookie(result.cookies);
    const me = signedMeSchema.parse(
      await (await fetch(`${base}/api/v1/me`, { headers: { cookie } })).json(),
    );
    const headers = { cookie, 'x-csrf-token': me.data.csrf_token };
    const before = (await pool.query('SELECT id,created_at,expires_at FROM sessions')).rows[0];
    await pool.query(
      `CREATE FUNCTION revoke_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'revoke fault'; END $$; CREATE TRIGGER revoke_fault BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION revoke_fault()`,
    );
    const failure = await post('sign-out', {}, headers);
    expect(failure.status).toBe(503);
    expect(failure.headers.getSetCookie()).toEqual([]);
    expect((await fetch(`${base}/api/v1/me`, { headers: { cookie } })).status).toBe(200);
    await pool.query('DROP TRIGGER revoke_fault ON sessions; DROP FUNCTION revoke_fault()');
    const success = await post('sign-out', {}, headers);
    expect(success.status).toBe(200);
    expect(success.headers.getSetCookie().some((value) => value.includes('Max-Age=0'))).toBe(true);
    const after = (await pool.query('SELECT * FROM sessions WHERE id=$1', [before.id])).rows[0];
    expect(after.revoked_at).not.toBeNull();
    expect(after.created_at).toEqual(before.created_at);
    expect(after.expires_at).toEqual(before.expires_at);
    expect((await fetch(`${base}/api/v1/me`, { headers: { cookie } })).status).toBe(401);
    const relogin = await post('sign-in', {
      login_name: fields.login_name,
      password: fields.password,
    });
    expect(relogin.status).toBe(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(1);
  });

  it('expired sessions return401, formal sign-in retains original user, and library ID reads never return the stored HMAC as token', async () => {
    const initialized = await service.initialize(fields);
    await listen();
    const row = (await pool.query('SELECT id,token_hash FROM sessions')).rows[0];
    const auth = createAuth(pool)!;
    const context = await auth.$context;
    const byId = await context.adapter.findOne<{ token?: string }>({
      model: 'session',
      where: [{ field: 'id', value: row.id }],
    });
    expect(byId?.token).toBeUndefined();
    await pool.query(
      "UPDATE sessions SET created_at=now()-interval '8 days',expires_at=now()-interval '1 day' WHERE id=$1",
      [row.id],
    );
    expect(
      (
        await fetch(`${base}/api/v1/me`, {
          headers: { cookie: sessionCookie(initialized.cookies) },
        })
      ).status,
    ).toBe(401);
    expect(
      (await post('sign-in', { login_name: fields.login_name, password: fields.password })).status,
    ).toBe(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(1);
  });

  it('rejects real Origin, strict fields, missing CSRF and unknown library paths without writes; all outcomes no-store', async () => {
    await listen();
    for (const badOrigin of ['', 'null', 'https://evil.invalid']) {
      const response = await post('initialize', fields, { origin: badOrigin });
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    for (const extra of [
      { owner_id: randomUUID() },
      { rememberMe: true },
      { callbackURL: '/' },
      { password: 'short' },
    ]) {
      expect((await post('initialize', { ...fields, ...extra })).status).toBe(400);
    }
    for (const path of ['sign-up/email', 'get-session', 'reset-password']) {
      const response = await post(path, {});
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(await counts()).toEqual([0, 0, 0, 0]);
    const initialized = await service.initialize(fields);
    const cookie = sessionCookie(initialized.cookies);
    expect((await post('sign-out', {}, { cookie })).status).toBe(403);
    expect(
      (
        await post(
          'claim',
          { login_name: 'x', password: fields.password, confirmed: true },
          { cookie },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post('sign-in', {
          login_name: fields.login_name,
          password: fields.password,
          user_id: randomUUID(),
        })
      ).status,
    ).toBe(400);
  });

  it('counts UTF-8 body bytes, handles malformed JSON, and catches resolver dependency errors before body gates', async () => {
    await listen();
    const tooLarge = await post('sign-in', {
      login_name: 'admin',
      password: fields.password,
      padding: '界'.repeat(44000),
    });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.headers.get('cache-control')).toBe('no-store');
    const malformed = await fetch(`${base}/api/v1/auth/sign-in`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    const initialized = await service.initialize(fields);
    const cookie = sessionCookie(initialized.cookies);
    await pool.query('ALTER TABLE sessions RENAME TO unavailable_sessions');
    const me = await fetch(`${base}/api/v1/me`, { headers: { cookie } });
    expect(me.status).toBe(503);
    const action = await fetch(`${base}/api/v1/conversations/messages`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(action.status).toBe(503);
  });
});

maybe('R1 auth finite uploads', () => {
  it('rejects Origin and declared/chunked UTF8 overflows before upload end and preserves exact byte boundary', async () => {
    const database = await createIntegrationDatabase();
    const accountService = createConfiguredAccountService(database.pool, {
      secret,
      origin,
      workspaceStatus: unconfigured,
    });
    const server = createServer((req, res) => {
      void handleRequest(req, res, { pool: database.pool, accountService, tzdbVersion: '2024a' });
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    async function upload(
      chunks: Buffer[],
      headers: Record<string, string>,
      end: boolean,
    ): Promise<{ status: number; closed: boolean; cache: string | undefined }> {
      const { promise, resolve, reject } = Promise.withResolvers<{
        status: number;
        closed: boolean;
        cache: string | undefined;
      }>();
      const req = request(`${base}/api/v1/auth/sign-in`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', ...headers },
      });
      // This real socket deadline detects waiting for unfinished HTTP input;
      // fake clocks cannot advance platform socket reads or server writes.
      req.setTimeout(1500, () => req.destroy(new Error('auth gate waited for upload end')));
      req.on('error', reject);
      req.on('response', (res) => {
        res.resume();
        res.on('end', () => {
          req.setTimeout(0);
          resolve({
            status: res.statusCode!,
            closed: res.headers.connection === 'close',
            cache: res.headers['cache-control'],
          });
        });
      });
      req.flushHeaders();
      for (const chunk of chunks) req.write(chunk);
      if (end) req.end();
      return promise;
    }
    try {
      expect(await upload([Buffer.from('{')], { origin: 'null' }, false)).toEqual({
        status: 403,
        closed: true,
        cache: 'no-store',
      });
      expect(await upload([], { 'content-length': '131073' }, false)).toEqual({
        status: 413,
        closed: true,
        cache: 'no-store',
      });
      const prefix = '{"padding":"';
      const suffix = '"}';
      const size = 131072 - Buffer.byteLength(prefix + suffix);
      const exact = Buffer.from(
        prefix + '界'.repeat(Math.floor(size / 3)) + 'x'.repeat(size % 3) + suffix,
      );
      expect(exact.length).toBe(131072);
      expect(
        (await upload([exact.subarray(0, 65535), exact.subarray(65535)], {}, true)).status,
      ).toBe(400);
      const over = Buffer.concat([exact, Buffer.from(' ')]);
      expect(
        await upload(
          [over.subarray(0, 65000), over.subarray(65000, 131072), over.subarray(131072)],
          {},
          false,
        ),
      ).toEqual({ status: 413, closed: true, cache: 'no-store' });
    } finally {
      server.closeAllConnections();
      if (server.listening) {
        const closed = Promise.withResolvers<void>();
        server.close((error) => (error ? closed.reject(error) : closed.resolve()));
        await closed.promise;
      }
      await database.close();
    }
  });
});
