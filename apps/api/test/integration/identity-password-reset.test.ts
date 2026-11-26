import { createFixtureConversation } from '../helpers/bot-conversation.js';
import { expectApplicationRejection } from '../helpers/application-error.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { handleRequest } from '../helpers/http-app.js';
import { type AccountService } from '../../src/features/identity/public.js';
import { createConfiguredAccountService } from '../../src/bootstrap/identity.js';
import { createAuth } from '../../src/features/identity/session/better-auth.js';
import {
  createInvitedAccountService,
  type InvitedAccountService,
} from '../../src/features/identity/account/invited-service.js';
import {
  parseIdentityKeyring,
  type IdentityKeyring,
} from '../../src/features/identity/security/email-security.js';
import type { IdentityMailConfig } from '../../src/features/identity/delivery/transport.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
// The in-process HTTP app resolves cookies with the environment secret.
const secret = process.env.BETTER_AUTH_SECRET;
const origin = 'http://localhost:3000';
const ip = '127.0.0.1';
const forgotten = 'the administrator forgotten password ';
const memberOriginal = 'ordinary original password ';
const replacement = ' replacement password with edges ';
const mail: IdentityMailConfig = {
  origin,
  from: 'identity@example.test',
  send: async () => ({ status: 'submitted', acceptanceId: 'isolated-simulator' }),
};
function fixtureKeys(): IdentityKeyring {
  return parseIdentityKeyring({
    version: 1,
    lookup: { id: 'lookup', key: randomBytes(32).toString('base64') },
    challenge: { active: 'challenge', keys: { challenge: randomBytes(32).toString('base64') } },
    encryption: { active: 'encryption', keys: { encryption: randomBytes(32).toString('base64') } },
    rateLimit: { id: 'quota', key: randomBytes(32).toString('base64') },
  });
}
const cookieHeader = (cookies: string[]) => cookies.map((value) => value.split(';')[0]).join('; ');

maybe('local administrator password reset against actual PostgreSQL', () => {
  let db: IntegrationDatabase,
    pool: Pool,
    accounts: AccountService,
    invited: InvitedAccountService,
    server: Server | undefined,
    adminId: string,
    adminCookies: string[],
    memberId: string,
    base: string;
  beforeEach(async () => {
    db = await createIntegrationDatabase();
    pool = db.pool;
    const keys = fixtureKeys();
    accounts = createConfiguredAccountService(pool, {
      secret,
      origin,
      keys,
      workspaceStatus: async () => ({ state: 'unconfigured', ownerIds: [] }),
    });
    invited = createInvitedAccountService(pool, { secret, origin, keys, mail });
    adminId = await legacyUser('Original Administrator');
    memberId = await legacyUser('Ordinary member');
    const candidates = await accounts.listMaintenanceCandidates();
    await accounts.bindLocal({
      selection: candidates.find((row) => row.displayName === 'Original Administrator')!.selection,
      confirmed: true,
      loginName: 'admin',
      password: forgotten,
    });
    await accounts.admitLocal({
      selection: (await accounts.listMaintenanceCandidates()).find(
        (row) => row.displayName === 'Ordinary member',
      )!.selection,
      confirmed: true,
      loginName: 'member',
      password: memberOriginal,
    });
    adminCookies = (await accounts.signIn({ login_name: 'admin', password: forgotten }, ip))
      .cookies;
    await createFixtureConversation(pool, adminId, { title: 'admin history' });
    await createFixtureConversation(pool, memberId, { title: 'member history' });
  });
  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
      server = undefined;
    }
    await db?.close();
  });
  async function legacyUser(displayName: string) {
    const id = randomUUID();
    await pool.query('INSERT INTO users(id,auth_email,display_name) VALUES($1,$2,$3)', [
      id,
      `${id}@local.invalid`,
      displayName,
    ]);
    await pool.query(
      "INSERT INTO auth_accounts(user_id,account_id) VALUES($1::uuid,'seed:'||$1::uuid::text)",
      [id],
    );
    return id;
  }
  async function listen() {
    server = createServer((req, res) => {
      void handleRequest(req, res, { pool, accountService: accounts, tzdbVersion: '2024a' });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function select(name: string) {
    const row = (await accounts.listPasswordResetCandidates()).find(
      (item) => item.displayName === name,
    )!;
    return row;
  }
  async function facts() {
    return JSON.stringify(
      (
        await pool.query(`SELECT jsonb_build_object(
          'users',(SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY id),'[]') FROM users u),
          'credentials',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM auth_accounts a),
          'sessions',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM sessions s),
          'admissions',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY user_id),'[]') FROM identity_account_admissions q),
          'bindings',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY user_id),'[]') FROM installation_admin i),
          'challenges',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM identity_challenges c),
          'conversations',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]') FROM conversations v)) AS value`)
      ).rows[0].value,
    );
  }
  async function userFacts(table: string, userId: string) {
    return JSON.stringify(
      (await pool.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE user_id=$1`, [userId]))
        .rows,
    );
  }

  it('resets the selected administrator: new password logs in, old fails, ids and owner data persist', async () => {
    await listen();
    expect(
      (await fetch(`${base}/api/v1/me`, { headers: { cookie: cookieHeader(adminCookies) } }))
        .status,
    ).toBe(200);
    const memberBefore = {
      credentials: await userFacts('auth_accounts', memberId),
      sessions: await userFacts('sessions', memberId),
      admissions: await userFacts('identity_account_admissions', memberId),
    };
    const usersBefore = JSON.stringify(
      (await pool.query('SELECT to_jsonb(u) v FROM users u ORDER BY id')).rows,
    );
    const conversationsBefore = JSON.stringify(
      (await pool.query('SELECT to_jsonb(c) v FROM conversations c ORDER BY id')).rows,
    );
    expect(JSON.stringify(await accounts.listPasswordResetCandidates())).not.toContain(adminId);
    const target = await select('Original Administrator');
    expect(target).toMatchObject({ installationAdmin: true, status: 'active', eligible: true });
    expect(
      await accounts.resetLocalPassword({
        selection: target.selection,
        confirmed: true,
        password: replacement,
      }),
    ).toEqual({ reset: true });

    await expectApplicationRejection(
      accounts.signIn({ login_name: 'admin', password: forgotten }, ip),
      { status: 401 },
    );
    // Passwords are not trimmed: the edge spaces are part of the secret.
    await expectApplicationRejection(
      accounts.signIn({ login_name: 'admin', password: replacement.trim() }, ip),
      { status: 401 },
    );
    expect(
      (await accounts.signIn({ login_name: 'admin', password: replacement }, ip)).cookies.length,
    ).toBeGreaterThan(0);
    expect((await accounts.getBoundAdministrator())!.userId).toBe(adminId);
    const credential = (
      await pool.query('SELECT account_id,password_hash FROM auth_accounts WHERE user_id=$1', [
        adminId,
      ])
    ).rows;
    expect(credential).toHaveLength(1);
    expect(credential[0].account_id).toBe(adminId);
    expect(
      await (
        await createAuth(pool, { secret })!.$context
      ).password.verify({ hash: credential[0].password_hash, password: replacement }),
    ).toBe(true);

    // The pre-reset session no longer resolves; the post-reset login is a new one.
    expect(
      (await fetch(`${base}/api/v1/me`, { headers: { cookie: cookieHeader(adminCookies) } }))
        .status,
    ).toBe(401);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',
          [adminId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await pool.query(
          'SELECT credential_revision::int r FROM identity_account_admissions WHERE user_id=$1',
          [adminId],
        )
      ).rows[0].r,
    ).toBeGreaterThan(1);

    expect(
      JSON.stringify((await pool.query('SELECT to_jsonb(u) v FROM users u ORDER BY id')).rows),
    ).toBe(usersBefore);
    expect(
      JSON.stringify(
        (await pool.query('SELECT to_jsonb(c) v FROM conversations c ORDER BY id')).rows,
      ),
    ).toBe(conversationsBefore);
    expect({
      credentials: await userFacts('auth_accounts', memberId),
      sessions: await userFacts('sessions', memberId),
      admissions: await userFacts('identity_account_admissions', memberId),
    }).toEqual(memberBefore);
    expect(
      (await accounts.signIn({ login_name: 'member', password: memberOriginal }, ip)).cookies
        .length,
    ).toBeGreaterThan(0);
  });

  it('also resets an admitted ordinary user without touching the administrator', async () => {
    const adminBefore = {
      credentials: await userFacts('auth_accounts', adminId),
      sessions: await userFacts('sessions', adminId),
      admissions: await userFacts('identity_account_admissions', adminId),
    };
    const target = await select('Ordinary member');
    expect(target).toMatchObject({ installationAdmin: false, eligible: true });
    await accounts.resetLocalPassword({
      selection: target.selection,
      confirmed: true,
      password: replacement,
    });
    await expectApplicationRejection(
      accounts.signIn({ login_name: 'member', password: memberOriginal }, ip),
      { status: 401 },
    );
    expect(
      (await accounts.signIn({ login_name: 'member', password: replacement }, ip)).cookies.length,
    ).toBeGreaterThan(0);
    expect({
      credentials: await userFacts('auth_accounts', adminId),
      sessions: await userFacts('sessions', adminId),
      admissions: await userFacts('identity_account_admissions', adminId),
    }).toEqual(adminBefore);
  });

  it('revokes pending verification challenges and suppresses their queued mail in the same commit', async () => {
    const actor = {
      ownerId: adminId,
      sessionId: (await pool.query('SELECT id FROM sessions WHERE user_id=$1', [adminId])).rows[0]
        .id as string,
      displayName: 'Original Administrator',
      timezoneId: null,
    };
    await invited.requestContact(
      actor,
      { email: 'admin@example.test', current_password: forgotten },
      ip,
    );
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM identity_challenges WHERE user_id=$1 AND revoked_at IS NULL AND consumed_at IS NULL',
          [adminId],
        )
      ).rows[0].n,
    ).toBe(1);
    const target = await select('Original Administrator');
    await accounts.resetLocalPassword({
      selection: target.selection,
      confirmed: true,
      password: replacement,
    });
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM identity_challenges WHERE user_id=$1 AND revoked_at IS NULL AND consumed_at IS NULL',
          [adminId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM identity_mail_deliveries WHERE status='queued' AND challenge_id IN (SELECT id FROM identity_challenges WHERE user_id=$1)",
          [adminId],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('refuses without explicit confirmation, unknown selection, or invalid password and changes nothing', async () => {
    const target = await select('Original Administrator');
    const before = await facts();
    await expectApplicationRejection(
      accounts.resetLocalPassword({
        selection: target.selection,
        confirmed: false as unknown as true,
        password: replacement,
      }),
      { status: 400 },
    );
    await expectApplicationRejection(
      accounts.resetLocalPassword({
        selection: randomUUID(),
        confirmed: true,
        password: replacement,
      }),
      { status: 400 },
    );
    for (const password of ['short', 'x'.repeat(129)])
      await expectApplicationRejection(
        accounts.resetLocalPassword({ selection: target.selection, confirmed: true, password }),
        { status: 400 },
      );
    expect(await facts()).toBe(before);
    expect(
      (await accounts.signIn({ login_name: 'admin', password: forgotten }, ip)).cookies.length,
    ).toBeGreaterThan(0);
  });

  for (const conflict of [
    'disabled',
    'deleted_requested',
    'not admitted',
    'no password',
    'foreign credential',
  ] as const) {
    it(`refuses an ineligible ${conflict} account and changes nothing`, async () => {
      const victimId = await legacyUser(`Victim ${conflict}`);
      const hash = await (await createAuth(pool, { secret })!.$context).password.hash(forgotten);
      await pool.query('UPDATE auth_accounts SET account_id=$1,password_hash=$2 WHERE user_id=$1', [
        victimId,
        hash,
      ]);
      await pool.query(
        "INSERT INTO identity_account_admissions(user_id,source,admitted_at) VALUES($1,'local_maintenance',clock_timestamp())",
        [victimId],
      );
      if (conflict === 'disabled' || conflict === 'deleted_requested')
        await pool.query('UPDATE users SET status=$2 WHERE id=$1', [victimId, conflict]);
      if (conflict === 'not admitted')
        await pool.query('DELETE FROM identity_account_admissions WHERE user_id=$1', [victimId]);
      if (conflict === 'no password')
        await pool.query('UPDATE auth_accounts SET password_hash=NULL WHERE user_id=$1', [
          victimId,
        ]);
      if (conflict === 'foreign credential')
        await pool.query('UPDATE auth_accounts SET account_id=$2 WHERE user_id=$1', [
          victimId,
          'someone-else',
        ]);
      const candidate = await select(`Victim ${conflict}`);
      expect(candidate.eligible).toBe(false);
      const before = await facts();
      await expectApplicationRejection(
        accounts.resetLocalPassword({
          selection: candidate.selection,
          confirmed: true,
          password: replacement,
        }),
        { status: 409 },
      );
      expect(await facts()).toBe(before);
    });
  }

  it('rolls everything back, leaving the old password valid, when the commit path fails', async () => {
    const target = await select('Original Administrator');
    const before = await facts();
    await pool.query(
      `CREATE FUNCTION reset_131_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$`,
    );
    await pool.query(
      'CREATE TRIGGER reset_131_fail BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION reset_131_fail()',
    );
    await expectApplicationRejection(
      accounts.resetLocalPassword({
        selection: target.selection,
        confirmed: true,
        password: replacement,
      }),
      { status: 503 },
    );
    await pool.query('DROP TRIGGER reset_131_fail ON sessions');
    expect(await facts()).toBe(before);
    expect(
      (await accounts.signIn({ login_name: 'admin', password: forgotten }, ip)).cookies.length,
    ).toBeGreaterThan(0);
  });
});
