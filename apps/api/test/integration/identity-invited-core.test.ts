import {
  applicationErrorEvidence,
  expectApplicationRejection,
} from '../helpers/application-error.js';
import { httpStatusForError } from '@along/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../../src/features/identity/session/actor.js';
import { type AccountService } from '../../src/features/identity/public.js';
import { createConfiguredAccountService } from '../../src/bootstrap/identity.js';
import {
  createInvitedAccountService,
  type InvitedAccountService,
} from '../../src/features/identity/account/invited-service.js';
import {
  openIdentity,
  parseIdentityKeyring,
  type IdentityKeyring,
} from '../../src/features/identity/security/email-security.js';
import type { IdentityMailConfig } from '../../src/features/identity/delivery/transport.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const secret = 'isolated-112-p1-behavior-test-only';
const origin = 'http://localhost:3000';
const adminPassword = 'administrator original password ';
const memberPassword = 'member original password ';
const replacement = 'member replacement password ';
const ip = '127.0.0.1';
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
function gatedPool(pool: Pool, match: RegExp, after: boolean) {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let used = false;
  const facade = Object.create(pool) as Pool;
  facade.connect = (async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, property) {
        if (property === 'query')
          return async (text: string, values?: unknown[]) => {
            if (!used && match.test(text)) {
              used = true;
              if (after) {
                const result = await target.query(text, values);
                entered.resolve();
                await release.promise;
                return result;
              }
              entered.resolve();
              await release.promise;
            }
            return target.query(text, values);
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PoolClient;
  }) as Pool['connect'];
  return { pool: facade, entered: entered.promise, release: release.resolve };
}

maybe('invited identity core actual PostgreSQL behavior', () => {
  let db: IntegrationDatabase,
    pool: Pool,
    keys: IdentityKeyring,
    accounts: AccountService,
    service: InvitedAccountService,
    admin: Actor;
  beforeEach(async () => {
    db = await createIntegrationDatabase();
    pool = db.pool;
    keys = fixtureKeys();
    accounts = createConfiguredAccountService(pool, {
      secret,
      origin,
      keys,
      workspaceStatus: async () => ({ state: 'unconfigured', ownerIds: [] }),
    });
    service = createInvitedAccountService(pool, { secret, origin, keys, mail });
    await accounts.initialize({
      login_name: 'admin',
      password: adminPassword,
      display_name: 'Original Administrator',
    });
    const row = (
      await pool.query('SELECT user_id,id FROM sessions ORDER BY created_at DESC LIMIT 1')
    ).rows[0];
    admin = {
      ownerId: row.user_id,
      sessionId: row.id,
      displayName: 'Administrator',
      timezoneId: null,
    };
    await service.requestContact(
      admin,
      { email: 'admin@example.test', current_password: adminPassword },
      ip,
    );
    await service.verifyContact(admin, { token: await latestToken('verify_contact') }, ip);
  });
  afterEach(async () => {
    await db?.close();
  });
  async function latestToken(purpose: string, userId?: string) {
    const row = (
      await pool.query(
        `SELECT d.* FROM identity_mail_deliveries d JOIN identity_challenges c ON c.id=d.challenge_id WHERE c.purpose=$1 AND ($2::uuid IS NULL OR c.user_id=$2) AND d.payload_ciphertext IS NOT NULL ORDER BY d.created_at DESC,d.id DESC LIMIT 1`,
        [purpose, userId ?? null],
      )
    ).rows[0];
    if (!row) throw Error('fixture delivery not found');
    const payload: unknown = JSON.parse(
      openIdentity(
        keys,
        {
          ciphertext: row.payload_ciphertext,
          nonce: row.payload_nonce,
          tag: row.payload_tag,
          encryption_key_id: row.encryption_key_id,
        },
        `identity:delivery:${row.id}:${row.challenge_id}:${row.purpose}:${row.generation}`,
      ),
    );
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('token' in payload) ||
      typeof payload.token !== 'string'
    )
      throw Error('invalid isolated fixture delivery');
    return payload.token;
  }
  async function invite(address = 'member@example.test') {
    const result = await service.createInvitation(
      admin,
      { email: address, current_password: adminPassword, idempotency_key: randomUUID() },
      ip,
    );
    return { id: result.invitation.id, token: await latestToken('invitation') };
  }
  async function member() {
    const invitation = await invite();
    await service.acceptInvitation(
      {
        token: invitation.token,
        login_name: 'member',
        password: memberPassword,
        display_name: 'Member',
      },
      ip,
    );
    const signed = await accounts.signIn({ login_name: 'member', password: memberPassword }, ip);
    const row = (
      await pool.query(
        "SELECT s.id,s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.display_name='Member' ORDER BY s.created_at DESC LIMIT 1",
      )
    ).rows[0];
    return {
      actor: { ownerId: row.user_id, sessionId: row.id, displayName: 'Member', timezoneId: null },
      headers: new Headers({
        cookie: signed.cookies.map((value) => value.split(';')[0]).join('; '),
      }),
    };
  }

  it('atomically creates one independent admitted identity and rejects duplicate/cross-purpose/signed-in acceptance', async () => {
    const invitation = await invite();
    const input = {
      token: invitation.token,
      login_name: 'member',
      password: memberPassword,
      display_name: 'Member',
    };
    await expectApplicationRejection(service.acceptInvitation(input, ip, admin), {
      status: 409,
      details: { reason: 'SIGN_OUT_REQUIRED' },
    });
    await expect(
      service.resetPassword({ token: invitation.token, new_password: replacement }, ip),
    ).rejects.toMatchObject({ details: { reason: 'TOKEN_INVALID' } });
    const outcomes = await Promise.allSettled([
      service.acceptInvitation(input, ip),
      service.acceptInvitation(input, ip),
    ]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const counts = (
      await pool.query(
        'SELECT (SELECT count(*)::int FROM users) users,(SELECT count(*)::int FROM auth_accounts) credentials,(SELECT count(*)::int FROM identity_account_admissions) admissions,(SELECT count(*)::int FROM identity_contacts) contacts,(SELECT count(*)::int FROM sessions) sessions',
      )
    ).rows[0];
    expect(counts).toEqual({ users: 2, credentials: 2, admissions: 2, contacts: 2, sessions: 1 });
    expect(
      (await accounts.signIn({ email: 'MEMBER@example.test', password: memberPassword }, ip))
        .cookies.length,
    ).toBeGreaterThan(0);
  });
  it('requires admission for original ordinary credentials and explicitly admits the same identity without rewriting its hash', async () => {
    const admitted = await member();
    const before = (
      await pool.query('SELECT * FROM auth_accounts WHERE user_id=$1', [admitted.actor.ownerId])
    ).rows[0];
    await pool.query('DELETE FROM identity_account_admissions WHERE user_id=$1', [
      admitted.actor.ownerId,
    ]);
    await expectApplicationRejection(
      accounts.signIn({ login_name: 'member', password: memberPassword }, ip),
      { status: 401 },
    );
    const selected = (await accounts.listMaintenanceCandidates()).find(
      (row) => row.displayName === 'Member',
    )!;
    expect(
      await accounts.admitLocal({
        selection: selected.selection,
        confirmed: true,
        loginName: 'member',
        password: memberPassword,
      }),
    ).toEqual({ admitted: true, userId: admitted.actor.ownerId });
    expect(
      (await pool.query('SELECT * FROM auth_accounts WHERE user_id=$1', [admitted.actor.ownerId]))
        .rows[0],
    ).toEqual(before);
    expect(
      (await accounts.signIn({ login_name: 'member', password: memberPassword }, ip)).cookies
        .length,
    ).toBeGreaterThan(0);
  });
  it('replays invitation idempotency only with current password and original action parameters', async () => {
    const input = {
      email: 'member@example.test',
      current_password: adminPassword,
      idempotency_key: randomUUID(),
    };
    const first = await service.createInvitation(admin, input, ip);
    const replay = await service.createInvitation(
      admin,
      { ...input, email: 'MEMBER@example.test' },
      ip,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.invitation.id).toBe(first.invitation.id);
    await expect(
      service.createInvitation(admin, { ...input, email: 'other@example.test' }, ip),
    ).rejects.toMatchObject({ details: { reason: 'IDEMPOTENCY_MISMATCH' } });
    await expectApplicationRejection(
      service.createInvitation(admin, { ...input, current_password: 'incorrect password' }, ip),
      { status: 401 },
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM identity_challenges WHERE purpose='invitation'",
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it('revokes old generations on resend and closes accepted/revoked invitations without reopening', async () => {
    const invitation = await invite();
    const input = { current_password: adminPassword, idempotency_key: randomUUID() };
    const resent = await service.resendInvitation(admin, invitation.id, input, ip);
    expect(resent.invitation.generation).toBe(2);
    const currentToken = await latestToken('invitation');
    expect(
      (await service.resendInvitation(admin, invitation.id, input, ip)).invitation.delivery
        .delivery_id,
    ).toBe(resent.invitation.delivery.delivery_id);
    await expect(
      service.acceptInvitation(
        {
          token: invitation.token,
          login_name: 'member',
          password: memberPassword,
          display_name: 'Member',
        },
        ip,
      ),
    ).rejects.toMatchObject({ details: { reason: 'TOKEN_INVALID' } });
    await service.revokeInvitation(admin, invitation.id, { current_password: adminPassword }, ip);
    expect(
      await service.revokeInvitation(admin, invitation.id, { current_password: adminPassword }, ip),
    ).toEqual({ revoked: true });
    await expect(
      service.acceptInvitation(
        {
          token: currentToken,
          login_name: 'member',
          password: memberPassword,
          display_name: 'Member',
        },
        ip,
      ),
    ).rejects.toMatchObject({ details: { reason: 'TOKEN_INVALID' } });
  });
  it('serializes competing verified contacts and invalidates reset credentials on contact replacement', async () => {
    const { actor } = await member();
    await service.forgotPassword({ email: 'member@example.test' }, ip);
    const stale = await latestToken('reset_password', actor.ownerId);
    await service.requestContact(
      actor,
      { email: 'new@example.test', current_password: memberPassword },
      ip,
    );
    const memberToken = await latestToken('verify_contact', actor.ownerId);
    await service.requestContact(
      admin,
      { email: 'new@example.test', current_password: adminPassword },
      ip,
    );
    const adminToken = await latestToken('verify_contact', admin.ownerId);
    await expectApplicationRejection(service.verifyContact(admin, { token: memberToken }, ip), {
      status: 403,
    });
    const results = await Promise.allSettled([
      service.verifyContact(actor, { token: memberToken }, ip),
      service.verifyContact(admin, { token: adminToken }, ip),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM identity_contacts WHERE masked_email='n***@example.test'",
        )
      ).rows[0].n,
    ).toBe(1);
    if (results[0]!.status === 'fulfilled')
      await expect(
        service.resetPassword({ token: stale, new_password: replacement }, ip),
      ).rejects.toMatchObject({ details: { reason: 'TOKEN_INVALID' } });
  });
  it('atomically changes password, consumes reset and revokes every existing session without logging in', async () => {
    const { actor } = await member();
    await accounts.signIn({ login_name: 'member', password: memberPassword }, ip);
    await service.forgotPassword({ email: 'member@example.test' }, ip);
    const reset = await latestToken('reset_password', actor.ownerId);
    expect(await service.resetPassword({ token: reset, new_password: replacement }, ip)).toEqual({
      password_changed: true,
      authenticated: false,
    });
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',
          [actor.ownerId],
        )
      ).rows[0].n,
    ).toBe(0);
    await expectApplicationRejection(
      accounts.signIn({ login_name: 'member', password: memberPassword }, ip),
      { status: 401 },
    );
    await expect(
      service.resetPassword({ token: reset, new_password: memberPassword }, ip),
    ).rejects.toMatchObject({ details: { reason: 'TOKEN_INVALID' } });
    expect(
      (await accounts.signIn({ login_name: 'member', password: replacement }, ip)).cookies.length,
    ).toBeGreaterThan(0);
  });
  for (const first of ['reset', 'login'] as const) {
    it(`serializes same-user ${first}-first password reset versus old-password login`, async () => {
      const { actor } = await member();
      await service.forgotPassword({ email: 'member@example.test' }, ip);
      const reset = await latestToken('reset_password', actor.ownerId);
      const other = db.connect();
      const userLock =
        first === 'reset'
          ? /SELECT id FROM users WHERE id=ANY/
          : /SELECT id,status,auth_email FROM users WHERE auth_email/;
      const firstPool = gatedPool(pool, userLock, true),
        secondPool = gatedPool(
          other,
          first === 'reset'
            ? /SELECT id,status,auth_email FROM users WHERE auth_email/
            : /SELECT id FROM users WHERE id=ANY/,
          false,
        );
      try {
        const firstOperation =
          first === 'reset'
            ? createInvitedAccountService(firstPool.pool, {
                secret,
                origin,
                keys,
                mail,
              }).resetPassword({ token: reset, new_password: replacement }, ip)
            : createConfiguredAccountService(firstPool.pool, { secret, origin, keys }).signIn(
                { login_name: 'member', password: memberPassword },
                ip,
              );
        await firstPool.entered;
        const secondOperation =
          first === 'reset'
            ? createConfiguredAccountService(secondPool.pool, { secret, origin, keys }).signIn(
                { login_name: 'member', password: memberPassword },
                ip,
              )
            : createInvitedAccountService(secondPool.pool, {
                secret,
                origin,
                keys,
                mail,
              }).resetPassword({ token: reset, new_password: replacement }, ip);
        const secondSettled = secondOperation.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await secondPool.entered;
        secondPool.release();
        firstPool.release();
        await firstOperation;
        const second = await secondSettled;
        if (first === 'reset')
          expect('error' in second && httpStatusForError(second.error.code)).toBe(401);
        else expect('value' in second).toBe(true);
        expect(
          (
            await pool.query(
              'SELECT count(*)::int n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',
              [actor.ownerId],
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        firstPool.release();
        secondPool.release();
        await other.end();
      }
    });
  }
  it('rolls back password, token consumption and revocation together on a real session write failure', async () => {
    const { actor } = await member();
    await service.forgotPassword({ email: 'member@example.test' }, ip);
    const reset = await latestToken('reset_password', actor.ownerId);
    const original = (
      await pool.query('SELECT password_hash FROM auth_accounts WHERE user_id=$1', [actor.ownerId])
    ).rows[0].password_hash;
    await pool.query(
      "CREATE FUNCTION identity_core_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated fault'; END $$; CREATE TRIGGER identity_core_fault BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION identity_core_fault()",
    );
    await expectApplicationRejection(
      service.resetPassword({ token: reset, new_password: replacement }, ip),
      { status: 503 },
    );
    expect(
      (
        await pool.query('SELECT password_hash FROM auth_accounts WHERE user_id=$1', [
          actor.ownerId,
        ])
      ).rows[0].password_hash,
    ).toBe(original);
    expect(
      (
        await pool.query(
          "SELECT consumed_at,revoked_at FROM identity_challenges WHERE user_id=$1 AND purpose='reset_password'",
          [actor.ownerId],
        )
      ).rows[0],
    ).toEqual({ consumed_at: null, revoked_at: null });
    expect(
      (await pool.query('SELECT revoked_at FROM sessions WHERE id=$1', [actor.sessionId])).rows[0]
        .revoked_at,
    ).toBeNull();
  });
  it('protects sole administrator and atomically disables an ordinary account with all session/challenge revocation', async () => {
    const { actor } = await member();
    await expect(
      service.disableUser(
        admin,
        admin.ownerId,
        { current_password: adminPassword, confirmed: true },
        ip,
      ),
    ).rejects.toMatchObject({ details: { reason: 'SOLE_ADMIN_PROTECTED' } });
    await expect(
      service.requestDeletion(
        admin,
        { current_password: adminPassword, confirmed: true },
        new Headers(),
        ip,
      ),
    ).rejects.toMatchObject({ details: { reason: 'SOLE_ADMIN_PROTECTED' } });
    await expectApplicationRejection(
      service.disableUser(
        actor,
        admin.ownerId,
        { current_password: memberPassword, confirmed: true },
        ip,
      ),
      { status: 403 },
    );
    await service.forgotPassword({ email: 'member@example.test' }, ip);
    const reset = await latestToken('reset_password', actor.ownerId);
    await pool.query(
      "CREATE FUNCTION identity_core_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated fault'; END $$; CREATE TRIGGER identity_core_fault BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION identity_core_fault()",
    );
    await expectApplicationRejection(
      service.disableUser(
        admin,
        actor.ownerId,
        { current_password: adminPassword, confirmed: true },
        ip,
      ),
      { status: 503 },
    );
    expect(
      (await pool.query('SELECT status FROM users WHERE id=$1', [actor.ownerId])).rows[0].status,
    ).toBe('active');
    await pool.query('DROP TRIGGER identity_core_fault ON sessions');
    expect(
      await service.disableUser(
        admin,
        actor.ownerId,
        { current_password: adminPassword, confirmed: true },
        ip,
      ),
    ).toEqual({ disabled: true });
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',
          [actor.ownerId],
        )
      ).rows[0].n,
    ).toBe(0);
    await expect(
      service.resetPassword({ token: reset, new_password: replacement }, ip),
    ).rejects.toMatchObject({ details: { reason: 'TOKEN_INVALID' } });
    await expectApplicationRejection(
      accounts.signIn({ email: 'member@example.test', password: memberPassword }, ip),
      { status: 401 },
    );
  });
  it('binds signed list cursors to actor and collection and never exposes credential material', async () => {
    const { actor } = await member();
    await accounts.signIn({ login_name: 'member', password: memberPassword }, ip);
    const sessions = await service.sessions(actor, { limit: 1 });
    expect(sessions.next_cursor).not.toBeNull();
    await expectApplicationRejection(service.sessions(admin, { cursor: sessions.next_cursor }), {
      status: 400,
    });
    await expectApplicationRejection(service.users(actor, { cursor: sessions.next_cursor }), {
      status: 400,
    });
    expect(JSON.stringify(await service.account(actor))).not.toMatch(
      /auth_email|password|ciphertext|token_digest/,
    );
    const next = await service.sessions(actor, { limit: 1, cursor: sessions.next_cursor });
    expect(next.items[0]!.id).not.toBe(sessions.items[0]!.id);
  });
  it('publishes no cookie result when a real password transaction commits but its acknowledgement is lost', async () => {
    const { actor, headers } = await member();
    const facade = Object.create(pool) as Pool;
    facade.connect = (async () => {
      const client = await pool.connect();
      let business = false;
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query')
            return async (text: string, values?: unknown[]) => {
              if (/SELECT id FROM users WHERE id=ANY/.test(text)) business = true;
              const result = await target.query(text, values);
              if (business && text === 'COMMIT')
                throw Error('isolated COMMIT acknowledgement lost');
              return result;
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PoolClient;
    }) as Pool['connect'];
    const uncertain = createInvitedAccountService(facade, { secret, origin, keys, mail });
    await expectApplicationRejection(
      uncertain.changePassword(
        actor,
        { current_password: memberPassword, new_password: replacement },
        headers,
        ip,
      ),
      { status: 503 },
    );
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL',
          [actor.ownerId],
        )
      ).rows[0].n,
    ).toBe(0);
    await expectApplicationRejection(
      accounts.signIn({ login_name: 'member', password: memberPassword }, ip),
      { status: 401 },
    );
    expect(
      (await accounts.signIn({ login_name: 'member', password: replacement }, ip)).cookies.length,
    ).toBeGreaterThan(0);
  });
  it('preserves current session for others revoke, scopes single-session writes, and clears library cookies only after all revoke', async () => {
    const { actor, headers } = await member();
    await accounts.signIn({ login_name: 'member', password: memberPassword }, ip);
    const other = (
      await pool.query('SELECT id FROM sessions WHERE user_id=$1 AND id<>$2', [
        actor.ownerId,
        actor.sessionId,
      ])
    ).rows[0].id;
    await expectApplicationRejection(service.revokeSession(actor, admin.sessionId!, headers), {
      status: 404,
    });
    expect(await service.revokeSession(actor, other, headers)).toEqual({
      signed_out: false,
      cookies: [],
    });
    expect(await service.revokeSession(actor, other, headers)).toEqual({
      signed_out: false,
      cookies: [],
    });
    expect(
      await service.revokeSessions(
        actor,
        { scope: 'others', current_password: memberPassword },
        headers,
        ip,
      ),
    ).toEqual({ signed_out: false, cookies: [] });
    expect(
      (await pool.query('SELECT revoked_at FROM sessions WHERE id=$1', [actor.sessionId])).rows[0]
        .revoked_at,
    ).toBeNull();
    const result = await service.revokeSessions(
      actor,
      { scope: 'all', current_password: memberPassword },
      headers,
      ip,
    );
    expect(result.signed_out).toBe(true);
    expect(result.cookies.some((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });
  it('changes password and requests ordinary deletion without deleting identity or granting automatic login', async () => {
    const { actor, headers } = await member();
    const changed = await service.changePassword(
      actor,
      { current_password: memberPassword, new_password: replacement },
      headers,
      ip,
    );
    expect(changed.cookies.some((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
    await expectApplicationRejection(
      accounts.signIn({ login_name: 'member', password: memberPassword }, ip),
      { status: 401 },
    );
    const signed = await accounts.signIn({ login_name: 'member', password: replacement }, ip);
    const newSession = (
      await pool.query('SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL', [
        actor.ownerId,
      ])
    ).rows[0].id;
    const newHeaders = new Headers({
      cookie: signed.cookies.map((value) => value.split(';')[0]).join('; '),
    });
    const result = await service.requestDeletion(
      { ...actor, sessionId: newSession },
      { current_password: replacement, confirmed: true },
      newHeaders,
      ip,
    );
    expect(result.cookies.some((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
    expect(
      (await pool.query('SELECT status FROM users WHERE id=$1', [actor.ownerId])).rows[0].status,
    ).toBe('deleted_requested');
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM auth_accounts WHERE user_id=$1', [
          actor.ownerId,
        ])
      ).rows[0].n,
    ).toBe(1);
    await expectApplicationRejection(
      accounts.signIn({ login_name: 'member', password: replacement }, ip),
      { status: 401 },
    );
  });
  it('rejects expired tokens but permits explicit expired-invitation resend with a fresh generation', async () => {
    const invitation = await invite();
    await pool.query(
      "UPDATE identity_invitations SET created_at=clock_timestamp()-interval '49 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
      [invitation.id],
    );
    await pool.query(
      "UPDATE identity_challenges SET created_at=clock_timestamp()-interval '49 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE invitation_id=$1",
      [invitation.id],
    );
    await expect(
      service.acceptInvitation(
        {
          token: invitation.token,
          login_name: 'member',
          password: memberPassword,
          display_name: 'Member',
        },
        ip,
      ),
    ).rejects.toMatchObject({ details: { reason: 'TOKEN_INVALID' } });
    expect((await service.listInvitations(admin, {})).items[0]!.state).toBe('expired');
    const resent = await service.resendInvitation(
      admin,
      invitation.id,
      { current_password: adminPassword, idempotency_key: randomUUID() },
      ip,
    );
    expect(resent.invitation.state).toBe('pending');
    expect(resent.invitation.generation).toBe(2);
    expect(new Date(resent.invitation.expires_at).getTime() - Date.now()).toBeGreaterThan(
      47 * 3600000,
    );
  });
  it('replaces a verified contact and invalidates the old contact revision recovery token', async () => {
    const { actor } = await member();
    await service.forgotPassword({ email: 'member@example.test' }, ip);
    const old = await latestToken('reset_password', actor.ownerId);
    await service.requestContact(
      actor,
      { email: 'replacement@example.test', current_password: memberPassword },
      ip,
    );
    await service.verifyContact(
      actor,
      { token: await latestToken('verify_contact', actor.ownerId) },
      ip,
    );
    await expect(
      service.resetPassword({ token: old, new_password: replacement }, ip),
    ).rejects.toMatchObject({ details: { reason: 'TOKEN_INVALID' } });
    await expectApplicationRejection(
      accounts.signIn({ email: 'member@example.test', password: memberPassword }, ip),
      { status: 401 },
    );
    expect(
      (await accounts.signIn({ email: 'replacement@example.test', password: memberPassword }, ip))
        .cookies.length,
    ).toBeGreaterThan(0);
  });
  it('charges invitation resend quota even when its target does not exist', async () => {
    for (let attempt = 0; attempt <= 20; attempt += 1) {
      await expectApplicationRejection(
        service.resendInvitation(
          admin,
          randomUUID(),
          {
            current_password: adminPassword,
            idempotency_key: randomUUID(),
          },
          ip,
        ),
        { status: attempt < 20 ? 404 : 429 },
      );
    }
  });
  it('preflights missing historical contact keys independently of an anonymous recovery target', async () => {
    const unavailable = createInvitedAccountService(pool, {
      secret,
      origin,
      mail,
      keys: { ...keys, encryption: { active: 'next', keys: { next: randomBytes(32) } } },
    });
    for (const email of ['admin@example.test', 'absent@example.test']) {
      await expectApplicationRejection(unavailable.forgotPassword({ email }, ip), {
        status: 503,
      });
    }
    expect(await service.forgotPassword({ email: 'absent@example.test' }, ip)).toEqual({
      accepted: true,
    });
  });
  it('reports a missing live challenge key as unavailable and recovers without consuming the invitation', async () => {
    const invitation = await invite('missing-key@example.test');
    const unavailable = createInvitedAccountService(pool, {
      secret,
      origin,
      mail,
      keys: { ...keys, challenge: { active: 'next', keys: { next: randomBytes(32) } } },
    });
    const input = {
      token: invitation.token,
      login_name: 'restored_key',
      password: memberPassword,
      display_name: 'Restored Key',
    };
    for (const token of [input.token, randomBytes(32).toString('base64url')]) {
      await expectApplicationRejection(unavailable.acceptInvitation({ ...input, token }, ip), {
        status: 503,
      });
    }
    expect(
      (
        await pool.query('SELECT state,accepted_user_id FROM identity_invitations WHERE id=$1', [
          invitation.id,
        ])
      ).rows[0],
    ).toEqual({ state: 'pending', accepted_user_id: null });
    expect(await service.acceptInvitation(input, ip)).toEqual({
      account_created: true,
      authenticated: false,
    });
    await expectApplicationRejection(unavailable.acceptInvitation(input, ip), {
      status: 409,
    });
  });
  it('replays the original invitation result after challenge key rotation', async () => {
    const input = {
      email: 'rotated@example.test',
      current_password: adminPassword,
      idempotency_key: randomUUID(),
    };
    const first = await service.createInvitation(admin, input, ip);
    const rotated = createInvitedAccountService(pool, {
      secret,
      origin,
      mail,
      keys: {
        ...keys,
        challenge: { active: 'next', keys: { ...keys.challenge.keys, next: randomBytes(32) } },
      },
    });
    const replay = await rotated.createInvitation(admin, input, ip);
    expect(replay).toEqual({ invitation: first.invitation, replayed: true });
  });
  it('replays the original safe invitation result after later closure without issuing new credentials', async () => {
    const input = {
      email: 'closed@example.test',
      current_password: adminPassword,
      idempotency_key: randomUUID(),
    };
    const first = await service.createInvitation(admin, input, ip);
    await service.revokeInvitation(
      admin,
      first.invitation.id,
      { current_password: adminPassword },
      ip,
    );
    expect(await service.createInvitation(admin, input, ip)).toEqual({
      invitation: first.invitation,
      replayed: true,
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM identity_challenges WHERE purpose='invitation'",
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it('rejects resending an expired invitation when another pending invitation owns its address', async () => {
    const first = await invite('replacement-pending@example.test');
    await pool.query(
      "UPDATE identity_invitations SET created_at=clock_timestamp()-interval '49 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
      [first.id],
    );
    await service.createInvitation(
      admin,
      {
        email: 'replacement-pending@example.test',
        current_password: adminPassword,
        idempotency_key: randomUUID(),
      },
      ip,
    );
    await expectApplicationRejection(
      service.resendInvitation(
        admin,
        first.id,
        {
          current_password: adminPassword,
          idempotency_key: randomUUID(),
        },
        ip,
      ),
      { status: 409, details: { reason: 'CONTACT_UNAVAILABLE' } },
    );
  });
  for (const [first, second] of [
    ['accept', 'revoke'],
    ['revoke', 'accept'],
    ['accept', 'resend'],
    ['resend', 'accept'],
    ['resend', 'revoke'],
    ['revoke', 'resend'],
  ] as const) {
    it(`serializes invitation ${first}-first versus ${second} on independent connections`, async () => {
      const invitation = await invite();
      const other = db.connect();
      const addressLock = /SELECT pg_advisory_xact_lock\(\$1::bigint\)/;
      const lookupLock = /SELECT pg_advisory_xact_lock\(680068, 2\)/;
      const firstPool = gatedPool(pool, addressLock, true);
      // Two digest-dependent operations contend at the lookup guard before the
      // follower can reach the address lock; revoke does not take that guard.
      const secondPool = gatedPool(
        other,
        first !== 'revoke' && second !== 'revoke' ? lookupLock : addressLock,
        false,
      );
      const input = {
        token: invitation.token,
        login_name: 'racing_member',
        password: memberPassword,
        display_name: 'Racing Member',
      };
      const execute = (target: InvitedAccountService, action: typeof first | typeof second) => {
        if (action === 'accept') return target.acceptInvitation(input, ip);
        if (action === 'revoke')
          return target.revokeInvitation(
            admin,
            invitation.id,
            { current_password: adminPassword },
            ip,
          );
        return target.resendInvitation(
          admin,
          invitation.id,
          { current_password: adminPassword, idempotency_key: randomUUID() },
          ip,
        );
      };
      const settle = (operation: Promise<unknown>) =>
        operation.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      try {
        const leading = settle(
          execute(
            createInvitedAccountService(firstPool.pool, { secret, origin, keys, mail }),
            first,
          ),
        );
        await firstPool.entered;
        const following = settle(
          execute(
            createInvitedAccountService(secondPool.pool, { secret, origin, keys, mail }),
            second,
          ),
        );
        await secondPool.entered;
        secondPool.release();
        firstPool.release();
        const [winner, follower] = await Promise.all([leading, following]);
        expect(winner.ok).toBe(true);
        if (first === 'resend' && second === 'revoke') expect(follower.ok).toBe(true);
        else {
          if (follower.ok) throw new Error('Expected the follower to encounter a conflict');
          expect(applicationErrorEvidence(follower.error).status).toBe(409);
        }
        const accepted = first === 'accept';
        const state = accepted
          ? 'accepted'
          : first === 'resend' && second === 'accept'
            ? 'pending'
            : 'revoked';
        expect(
          (
            await pool.query(
              `SELECT i.state,i.generation::int AS generation,
             (SELECT count(*)::int FROM identity_account_admissions a WHERE a.invitation_id=i.id) AS admissions,
             (SELECT count(*)::int FROM auth_accounts a WHERE a.user_id=i.accepted_user_id) AS credentials,
             (SELECT count(*)::int FROM identity_contacts c WHERE c.user_id=i.accepted_user_id) AS contacts,
             (SELECT count(*)::int FROM sessions s WHERE s.user_id=i.accepted_user_id) AS sessions
             FROM identity_invitations i WHERE i.id=$1`,
              [invitation.id],
            )
          ).rows[0],
        ).toEqual({
          state,
          generation: first === 'resend' ? 2 : 1,
          admissions: accepted ? 1 : 0,
          credentials: accepted ? 1 : 0,
          contacts: accepted ? 1 : 0,
          sessions: 0,
        });
        if (state === 'pending') {
          expect(
            await service.acceptInvitation(
              { ...input, token: await latestToken('invitation') },
              ip,
            ),
          ).toEqual({
            account_created: true,
            authenticated: false,
          });
        }
      } finally {
        firstPool.release();
        secondPool.release();
        await other.end();
      }
    });
  }
  for (const fault of [
    { table: 'users', operation: 'INSERT' },
    { table: 'auth_accounts', operation: 'INSERT' },
    { table: 'identity_account_admissions', operation: 'INSERT' },
    { table: 'identity_contacts', operation: 'INSERT' },
    { table: 'identity_invitations', operation: 'UPDATE' },
    { table: 'identity_challenges', operation: 'UPDATE' },
  ] as const) {
    it(`rolls back invitation acceptance at the real ${fault.table} write and permits a clean retry`, async () => {
      const invitation = await invite();
      const snapshot = async () =>
        (
          await pool.query(`SELECT jsonb_build_object(
            'users',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM users t),
            'accounts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM auth_accounts t),
            'admissions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY user_id) FROM identity_account_admissions t),
            'contacts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM identity_contacts t),
            'invitations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM identity_invitations t),
            'challenges',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM identity_challenges t),
            'deliveries',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM identity_mail_deliveries t)
          ) AS facts`)
        ).rows[0].facts;
      const before = await snapshot();
      await pool.query(
        `CREATE FUNCTION isolated_accept_fault() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'isolated invitation write fault'; END $$;
         CREATE TRIGGER isolated_accept_fault BEFORE ${fault.operation} ON ${fault.table}
           FOR EACH ROW EXECUTE FUNCTION isolated_accept_fault()`,
      );
      const input = {
        token: invitation.token,
        login_name: 'atomic_invitee',
        password: memberPassword,
        display_name: 'Atomic invitee',
      };
      await expectApplicationRejection(service.acceptInvitation(input, ip), { status: 503 });
      expect(await snapshot()).toEqual(before);
      await pool.query(`DROP TRIGGER isolated_accept_fault ON ${fault.table}`);
      expect(await service.acceptInvitation(input, ip)).toEqual({
        account_created: true,
        authenticated: false,
      });
      expect(
        (
          await pool.query(
            `SELECT count(*)::int n FROM identity_invitations i
             JOIN users u ON u.id=i.accepted_user_id
             JOIN auth_accounts a ON a.user_id=u.id
             JOIN identity_account_admissions p ON p.user_id=u.id AND p.invitation_id=i.id
             JOIN identity_contacts c ON c.user_id=u.id
             WHERE i.id=$1 AND i.state='accepted'`,
            [invitation.id],
          )
        ).rows[0].n,
      ).toBe(1);
    });
  }
});
