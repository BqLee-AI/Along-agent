import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Actor } from '../../src/http/auth.js';
import {
  createAccountService,
  type AccountService,
} from '../../src/modules/identity/account-service.js';
import {
  createInvitedAccountService,
  type InvitedAccountService,
} from '../../src/modules/identity/invited-service.js';
import {
  lookupDigest,
  openIdentity,
  parseIdentityKeyring,
  type IdentityKeyring,
} from '../../src/modules/identity/email-security.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const suite = databaseUrl ? describe : describe.skip;
const secret = 'isolated-lookup-key-regression-secret';
const origin = 'http://localhost:3000';
const password = 'isolated administrator password ';
const ip = '127.0.0.1';
const mail = {
  origin,
  from: 'identity@example.test',
  send: async () => ({ status: 'submitted' as const, acceptanceId: 'fixture' }),
};

function fixtureKeys(): IdentityKeyring {
  return parseIdentityKeyring({
    version: 1,
    lookup: { id: 'old', key: randomBytes(32).toString('base64') },
    challenge: { active: 'challenge', keys: { challenge: randomBytes(32).toString('base64') } },
    encryption: { active: 'encryption', keys: { encryption: randomBytes(32).toString('base64') } },
    rateLimit: { id: 'quota', key: randomBytes(32).toString('base64') },
  });
}

suite('identity lookup key consistency on PostgreSQL', () => {
  let db: IntegrationDatabase,
    pool: Pool,
    old: IdentityKeyring,
    changed: IdentityKeyring,
    admin: Actor;
  let service: InvitedAccountService;
  let accounts: AccountService;
  let wrong: InvitedAccountService;
  let wrongAccounts: AccountService;
  beforeEach(async () => {
    db = await createIntegrationDatabase();
    pool = db.pool;
    old = fixtureKeys();
    changed = { ...old, lookup: { id: 'new', key: randomBytes(32) } };
    service = createInvitedAccountService(pool, { secret, origin, keys: old, mail });
    wrong = createInvitedAccountService(pool, { secret, origin, keys: changed, mail });
    const workspaceStatus = async () => ({ state: 'unconfigured' as const, ownerIds: [] });
    accounts = createAccountService(pool, { secret, origin, keys: old, workspaceStatus });
    wrongAccounts = createAccountService(pool, { secret, origin, keys: changed, workspaceStatus });
    await accounts.initialize({ login_name: 'admin', password, display_name: 'Administrator' });
    const row = (
      await pool.query('SELECT user_id,id FROM sessions ORDER BY created_at DESC LIMIT 1')
    ).rows[0];
    admin = {
      ownerId: row.user_id,
      sessionId: row.id,
      displayName: 'Administrator',
      timezoneId: null,
    };
  });
  afterEach(async () => {
    await db?.close();
  });

  async function token(purpose: string): Promise<string> {
    const row = (
      await pool.query(
        `SELECT d.* FROM identity_mail_deliveries d JOIN identity_challenges c ON c.id=d.challenge_id WHERE c.purpose=$1 ORDER BY d.created_at DESC,d.id DESC LIMIT 1`,
        [purpose],
      )
    ).rows[0];
    const payload = JSON.parse(
      openIdentity(
        old,
        {
          ciphertext: row.payload_ciphertext,
          nonce: row.payload_nonce,
          tag: row.payload_tag,
          encryption_key_id: row.encryption_key_id,
        },
        `identity:delivery:${row.id}:${row.challenge_id}:${row.purpose}:${row.generation}`,
      ),
    );
    return payload.token;
  }
  async function contact() {
    await service.requestContact(
      admin,
      { email: 'admin@example.test', current_password: password },
      ip,
    );
    await service.verifyContact(admin, { token: await token('verify_contact') }, ip);
  }
  async function invite() {
    const result = await service.createInvitation(
      admin,
      { email: 'member@example.test', current_password: password, idempotency_key: randomUUID() },
      ip,
    );
    return { id: result.invitation.id, token: await token('invitation') };
  }
  const unavailable = { httpStatus: 503 };

  it('fails closed uniformly for email lookups and all digest-dependent mutations, and recovers with the original key', async () => {
    await contact();
    const invitation = await invite();
    await service.requestContact(
      admin,
      { email: 'other@example.test', current_password: password },
      ip,
    );
    const verifyToken = await token('verify_contact');
    await service.forgotPassword({ email: 'admin@example.test' }, ip);
    const resetToken = await token('reset_password');
    for (const email of ['admin@example.test', 'nobody@example.test']) {
      await expect(wrong.forgotPassword({ email }, ip)).rejects.toMatchObject(unavailable);
      await expect(wrongAccounts.signIn({ email, password }, ip)).rejects.toMatchObject(
        unavailable,
      );
    }
    await expect(
      wrong.requestContact(admin, { email: 'admin@example.test', current_password: password }, ip),
    ).rejects.toMatchObject(unavailable);
    await expect(wrong.verifyContact(admin, { token: verifyToken }, ip)).rejects.toMatchObject(
      unavailable,
    );
    await expect(
      wrong.createInvitation(
        admin,
        { email: 'admin@example.test', current_password: password, idempotency_key: randomUUID() },
        ip,
      ),
    ).rejects.toMatchObject(unavailable);
    await expect(
      wrong.resendInvitation(
        admin,
        invitation.id,
        { current_password: password, idempotency_key: randomUUID() },
        ip,
      ),
    ).rejects.toMatchObject(unavailable);
    await expect(
      wrong.acceptInvitation(
        { token: invitation.token, login_name: 'member', password, display_name: 'Member' },
        ip,
      ),
    ).rejects.toMatchObject(unavailable);
    await expect(
      wrong.resetPassword({ token: resetToken, new_password: 'a replacement password ' }, ip),
    ).rejects.toMatchObject(unavailable);
    expect(
      (await wrongAccounts.signIn({ login_name: 'admin', password }, ip)).cookies.length,
    ).toBeGreaterThan(0);
    expect(
      (await accounts.signIn({ email: 'admin@example.test', password }, ip)).cookies.length,
    ).toBeGreaterThan(0);
    expect(await service.forgotPassword({ email: 'nobody@example.test' }, ip)).toEqual({
      accepted: true,
    });
    await service.acceptInvitation(
      { token: invitation.token, login_name: 'member', password, display_name: 'Member' },
      ip,
    );
    expect(
      (await accounts.signIn({ email: 'member@example.test', password }, ip)).cookies.length,
    ).toBeGreaterThan(0);
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM identity_contacts')).rows[0].count,
    ).toBe(2);
  });

  it('checks pending invitations and live challenges independently, but permits terminal history and rekeys expired invitations on resend', async () => {
    await contact();
    const invitation = await invite();
    await pool.query('UPDATE identity_contacts SET lookup_key_id=$1,lookup_digest=$2', [
      changed.lookup.id,
      lookupDigest(changed, 'admin@example.test'),
    ]);
    await expect(wrong.forgotPassword({ email: 'nobody@example.test' }, ip)).rejects.toMatchObject(
      unavailable,
    );
    await pool.query("UPDATE identity_invitations SET state='expired' WHERE id=$1", [
      invitation.id,
    ]);
    await expect(
      wrongAccounts.signIn({ email: 'nobody@example.test', password }, ip),
    ).rejects.toMatchObject(unavailable);
    await pool.query(
      'UPDATE identity_challenges SET revoked_at=clock_timestamp() WHERE consumed_at IS NULL',
    );
    expect(
      (await wrongAccounts.signIn({ email: 'admin@example.test', password }, ip)).cookies.length,
    ).toBeGreaterThan(0);
    const resent = await wrong.resendInvitation(
      admin,
      invitation.id,
      { current_password: password, idempotency_key: randomUUID() },
      ip,
    );
    expect(resent.invitation.state).toBe('pending');
    const row = (
      await pool.query('SELECT lookup_key_id,lookup_digest FROM identity_invitations WHERE id=$1', [
        invitation.id,
      ])
    ).rows[0];
    expect(row.lookup_key_id).toBe(changed.lookup.id);
    expect(row.lookup_digest.equals(lookupDigest(changed, 'member@example.test'))).toBe(true);
  });
  it('serializes competing first writes under different lookup key configurations', async () => {
    const results = await Promise.allSettled([
      service.requestContact(admin, { email: 'one@example.test', current_password: password }, ip),
      wrong.requestContact(admin, { email: 'two@example.test', current_password: password }, ip),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason).toMatchObject(unavailable);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM identity_challenges WHERE purpose='verify_contact' AND revoked_at IS NULL",
        )
      ).rows[0].count,
    ).toBe(1);
  });
});
