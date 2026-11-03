import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  authContactRequestSchema,
  authContactVerifySchema,
  authInvitationCreateSchema,
  authInvitationResendSchema,
  authInvitationRevokeSchema,
  authInvitationAcceptSchema,
  authPasswordForgotSchema,
  authPasswordResetSchema,
  authPasswordChangeSchema,
  authSessionsRevokeSchema,
  authDisableUserSchema,
  authListQuerySchema,
  type AccountView,
  type InvitationView,
  type DeliveryView,
  type SessionView,
  type ManagedAccountView,
} from '@along/contracts';
import type { Actor } from '../../http/auth.js';
import {
  HttpError,
  forbidden,
  isUuid,
  notFound,
  notReady,
  stateConflict,
  unauthorized,
  validationError,
} from '../../http/errors.js';
import { getWorkspaceAccountStatus, listWorkspaces } from '../workspaces/service.js';
import { createAuth } from './better-auth.js';
import { deriveAuthEmail } from './crypto.js';
import {
  challengeDigests,
  issueToken,
  loadIdentityKeyring,
  lookupDigest,
  normalizeContactEmail,
  openIdentity,
  sealIdentity,
  tokenDigest,
  type IdentityKeyring,
  type Purpose,
} from './email-security.js';
import { enqueueIdentityMail, requireIdentityMailReady, type IdentityMailConfig } from './mail.js';
import { requireLookupKey } from './lookup-key.js';
import {
  consumeIdentityQuota,
  type IdentityQuotaAction,
  type IdentityQuotaSubjects,
} from './rate-limit.js';

const schemas = {
  contact: authContactRequestSchema,
  verify: authContactVerifySchema,
  invite: authInvitationCreateSchema,
  resend: authInvitationResendSchema,
  revoke: authInvitationRevokeSchema,
  accept: authInvitationAcceptSchema,
  forgot: authPasswordForgotSchema,
  reset: authPasswordResetSchema,
  change: authPasswordChangeSchema,
  sessions: authSessionsRevokeSchema,
  disable: authDisableUserSchema,
  query: authListQuerySchema,
};
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError('invalid account fields');
  return result.data;
}
function quotaToken(input: unknown): string {
  if (!input || typeof input !== 'object' || !('token' in input) || typeof input.token !== 'string')
    return 'invalid-token-input';
  return input.token.slice(0, 4096) || 'invalid-token-input';
}
function conflict(reason: string): never {
  throw stateConflict('account state conflict', { reason });
}
function id(value: string) {
  if (!isUuid(value)) throw validationError('invalid identifier');
  return value;
}
function iso(value: Date | string): string {
  return new Date(value).toISOString();
}
interface User {
  id: string;
  display_name: string;
  status: string;
  auth_email: string;
}
interface Challenge {
  id: string;
  purpose: Purpose;
  user_id: string | null;
  invitation_id: string | null;
  lookup_digest: Buffer;
  lookup_key_id: string;
  token_key_id: string;
  generation: string | number;
  contact_revision: string | number | null;
  consumed_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
  candidate_ciphertext: Buffer | null;
  candidate_nonce: Buffer | null;
  candidate_tag: Buffer | null;
  encryption_key_id: string | null;
  masked_email: string | null;
}
interface Invitation {
  id: string;
  created_by: string;
  lookup_digest: Buffer;
  lookup_key_id: string;
  address_ciphertext: Buffer | null;
  address_nonce: Buffer | null;
  address_tag: Buffer | null;
  encryption_key_id: string | null;
  masked_email: string;
  state: InvitationView['state'];
  generation: string | number;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at_cursor?: string;
}
interface Contact {
  id: string;
  user_id: string;
  lookup_digest: Buffer;
  revision: string | number;
  masked_email: string;
  verified_at: Date;
  address_ciphertext: Buffer;
  address_nonce: Buffer;
  address_tag: Buffer;
  encryption_key_id: string;
}
export interface InvitedAccountServiceOptions {
  secret?: string;
  origin?: string;
  keys?: IdentityKeyring;
  mail?: IdentityMailConfig;
}
export interface InvitedAccountService {
  account(actor: Actor): Promise<AccountView>;
  requestContact(
    actor: Actor,
    input: unknown,
    ip: string,
  ): Promise<{ contact_state: 'pending'; delivery: DeliveryView }>;
  verifyContact(actor: Actor, input: unknown, ip: string): Promise<{ contact_state: 'verified' }>;
  listInvitations(
    actor: Actor,
    query: unknown,
  ): Promise<{ items: InvitationView[]; next_cursor: string | null }>;
  createInvitation(
    actor: Actor,
    input: unknown,
    ip: string,
  ): Promise<{ invitation: InvitationView; replayed: boolean }>;
  resendInvitation(
    actor: Actor,
    id: string,
    input: unknown,
    ip: string,
  ): Promise<{ invitation: InvitationView }>;
  revokeInvitation(
    actor: Actor,
    id: string,
    input: unknown,
    ip: string,
  ): Promise<{ revoked: true }>;
  acceptInvitation(
    input: unknown,
    ip: string,
    existingActor?: Actor | null,
  ): Promise<{ account_created: true; authenticated: false }>;
  forgotPassword(input: unknown, ip: string): Promise<{ accepted: true }>;
  resetPassword(
    input: unknown,
    ip: string,
  ): Promise<{ password_changed: true; authenticated: false }>;
  changePassword(
    actor: Actor,
    input: unknown,
    headers: Headers,
    ip: string,
  ): Promise<{ cookies: string[] }>;
  sessions(
    actor: Actor,
    query: unknown,
  ): Promise<{ items: SessionView[]; next_cursor: string | null }>;
  revokeSession(
    actor: Actor,
    id: string,
    headers: Headers,
  ): Promise<{ signed_out: boolean; cookies: string[] }>;
  revokeSessions(
    actor: Actor,
    input: unknown,
    headers: Headers,
    ip: string,
  ): Promise<{ signed_out: boolean; cookies: string[] }>;
  users(
    actor: Actor,
    query: unknown,
  ): Promise<{ items: ManagedAccountView[]; next_cursor: string | null }>;
  disableUser(actor: Actor, id: string, input: unknown, ip: string): Promise<{ disabled: true }>;
  requestDeletion(
    actor: Actor,
    input: unknown,
    headers: Headers,
    ip: string,
  ): Promise<{ cookies: string[] }>;
}

export function createInvitedAccountService(
  pool: Pool,
  options: InvitedAccountServiceOptions = {},
): InvitedAccountService {
  const secret = options.secret ?? process.env.BETTER_AUTH_SECRET;
  const origin = options.origin ?? process.env.APP_ORIGIN ?? 'http://localhost:3000';
  const keys = () => options.keys ?? loadIdentityKeyring();
  const mailReady = () => requireIdentityMailReady({ mail: options.mail });
  async function tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    try {
      if (!secret) throw notReady('authentication unavailable');
      client = await pool.connect();
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* Unknown outcome never publishes cookies. */
        }
      }
      if (error instanceof HttpError) throw error;
      throw notReady('account dependency unavailable; inspect current state before retrying');
    } finally {
      client?.release();
    }
  }
  function library(client?: PoolClient) {
    const auth = createAuth(pool, { secret, origin, client });
    if (!auth) throw notReady('authentication unavailable');
    return auth;
  }
  async function now(client: PoolClient): Promise<Date> {
    return (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  }
  async function addressLock(client: PoolClient, digest: Buffer) {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      digest.readBigInt64BE().toString(),
    ]);
  }
  async function lockUsers(client: PoolClient, ids: string[]) {
    await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
      [...new Set(ids)].sort(),
    ]);
  }
  async function actorUser(client: PoolClient, actor: Actor, admin = false): Promise<User> {
    if (!actor.sessionId) throw unauthorized();
    const user = (
      await client.query<User>(
        `SELECT u.id,u.display_name,u.status,u.auth_email FROM users u JOIN identity_account_admissions a ON a.user_id=u.id WHERE u.id=$1 AND u.status='active'`,
        [actor.ownerId],
      )
    ).rows[0];
    if (
      !user ||
      !(
        await client.query(
          'SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()',
          [actor.sessionId, actor.ownerId],
        )
      ).rowCount
    )
      throw unauthorized();
    if (
      admin &&
      !(await client.query('SELECT 1 FROM installation_admin WHERE user_id=$1', [actor.ownerId]))
        .rowCount
    )
      throw forbidden();
    return user;
  }
  async function verifyPassword(client: PoolClient, userId: string, raw: string) {
    const context = await library(client).$context;
    const credential = (
      await client.query<{ id: string; account_id: string; password_hash: string | null }>(
        'SELECT id,account_id,password_hash FROM auth_accounts WHERE user_id=$1 ORDER BY id',
        [userId],
      )
    ).rows;
    if (
      credential.length !== 1 ||
      credential[0]!.account_id !== userId ||
      !credential[0]!.password_hash
    ) {
      await context.password.hash(raw);
      throw unauthorized();
    }
    if (!(await context.password.verify({ hash: credential[0]!.password_hash!, password: raw })))
      throw unauthorized();
    return credential[0]!;
  }
  async function quota(
    action: IdentityQuotaAction,
    ip: string,
    dimensions: Omit<IdentityQuotaSubjects, 'ip'>,
  ) {
    await consumeIdentityQuota(pool, keys(), action, { ip, ...dimensions });
  }
  async function revokeChallenges(client: PoolClient, condition: string, args: unknown[]) {
    await client.query(
      `UPDATE identity_challenges SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE ${condition} AND consumed_at IS NULL`,
      args,
    );
    await client.query(
      `UPDATE identity_mail_deliveries d SET status='suppressed',updated_at=clock_timestamp(),finished_at=clock_timestamp(),payload_ciphertext=NULL,payload_nonce=NULL,payload_tag=NULL,encryption_key_id=NULL,payload_erased_at=clock_timestamp() WHERE d.status='queued' AND d.challenge_id IN (SELECT id FROM identity_challenges WHERE ${condition} AND revoked_at IS NOT NULL)`,
      args,
    );
  }
  async function invalidateUser(client: PoolClient, userId: string) {
    await client.query(
      'UPDATE identity_account_admissions SET credential_revision=credential_revision+1 WHERE user_id=$1',
      [userId],
    );
    await revokeChallenges(client, 'user_id=$1', [userId]);
    await client.query(
      'UPDATE sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1',
      [userId],
    );
  }
  async function clearCookies(headers: Headers) {
    try {
      return (await library().api.signOut({ headers, returnHeaders: true })).headers.getSetCookie();
    } catch {
      throw notReady('change committed; library cookie cleanup unavailable');
    }
  }
  async function contact(client: PoolClient, userId: string): Promise<Contact | undefined> {
    return (
      await client.query<Contact>('SELECT * FROM identity_contacts WHERE user_id=$1', [userId])
    ).rows[0];
  }
  function contactAddress(k: IdentityKeyring, row: Contact) {
    return openIdentity(
      k,
      {
        ciphertext: row.address_ciphertext,
        nonce: row.address_nonce,
        tag: row.address_tag,
        encryption_key_id: row.encryption_key_id,
      },
      `identity:contact:${row.id}:${row.user_id}:${row.revision}`,
    );
  }
  function invitationAddress(k: IdentityKeyring, row: Invitation) {
    if (!row.address_ciphertext || !row.address_nonce || !row.address_tag || !row.encryption_key_id)
      throw notReady('invitation encryption unavailable');
    return openIdentity(
      k,
      {
        ciphertext: row.address_ciphertext,
        nonce: row.address_nonce,
        tag: row.address_tag,
        encryption_key_id: row.encryption_key_id,
      },
      `identity:invitation:${row.id}`,
    );
  }
  async function putContact(
    client: PoolClient,
    k: IdentityKeyring,
    userId: string,
    address: string,
    digest: Buffer,
    masked: string,
  ) {
    const previous = await contact(client, userId);
    const contactId = previous?.id ?? randomUUID(),
      revision = Number(previous?.revision ?? 0) + 1;
    const sealed = sealIdentity(k, address, `identity:contact:${contactId}:${userId}:${revision}`);
    await client.query(
      `INSERT INTO identity_contacts(id,user_id,lookup_digest,lookup_key_id,address_ciphertext,address_nonce,address_tag,encryption_key_id,masked_email,revision,verified_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp(),clock_timestamp(),clock_timestamp()) ON CONFLICT(user_id) DO UPDATE SET lookup_digest=EXCLUDED.lookup_digest,lookup_key_id=EXCLUDED.lookup_key_id,address_ciphertext=EXCLUDED.address_ciphertext,address_nonce=EXCLUDED.address_nonce,address_tag=EXCLUDED.address_tag,encryption_key_id=EXCLUDED.encryption_key_id,masked_email=EXCLUDED.masked_email,revision=EXCLUDED.revision,verified_at=EXCLUDED.verified_at,updated_at=EXCLUDED.updated_at`,
      [
        contactId,
        userId,
        digest,
        k.lookup.id,
        sealed.ciphertext,
        sealed.nonce,
        sealed.tag,
        sealed.encryption_key_id,
        masked,
        revision,
      ],
    );
  }
  async function issueChallenge(
    client: PoolClient,
    k: IdentityKeyring,
    input: {
      purpose: Purpose;
      userId?: string;
      invitationId?: string;
      digest: Buffer;
      generation: number;
      address: string;
      masked?: string;
      contactRevision?: number;
      at: Date;
    },
  ) {
    const challengeId = randomUUID(),
      raw = issueToken();
    const expiresAt = new Date(
      input.at.getTime() + (input.purpose === 'invitation' ? 48 * 60 : 30) * 60000,
    );
    const sealed =
      input.purpose === 'verify_contact'
        ? sealIdentity(
            k,
            input.address,
            `identity:challenge:${challengeId}:${input.userId}:verify_contact:${input.generation}`,
          )
        : null;
    await client.query(
      `INSERT INTO identity_challenges(id,purpose,token_digest,token_key_id,user_id,invitation_id,lookup_digest,lookup_key_id,generation,contact_revision,candidate_ciphertext,candidate_nonce,candidate_tag,encryption_key_id,masked_email,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        challengeId,
        input.purpose,
        tokenDigest(k, input.purpose, raw),
        k.challenge.active,
        input.userId ?? null,
        input.invitationId ?? null,
        input.digest,
        k.lookup.id,
        input.generation,
        input.contactRevision ?? null,
        sealed?.ciphertext ?? null,
        sealed?.nonce ?? null,
        sealed?.tag ?? null,
        sealed?.encryption_key_id ?? null,
        input.masked ?? null,
        input.at,
        expiresAt,
      ],
    );
    return enqueueIdentityMail(client, k, {
      challengeId,
      purpose: input.purpose,
      generation: input.generation,
      to: input.address,
      token: raw,
      expiresAt,
    });
  }
  async function findChallenge(
    client: PoolClient,
    k: IdentityKeyring,
    purpose: Purpose,
    raw: string,
  ): Promise<Challenge> {
    // A missing retained key is a global dependency fault for this purpose,
    // not evidence that the caller's otherwise valid token never existed.
    if (
      (
        await client.query(
          `SELECT 1 FROM identity_challenges
           WHERE purpose=$1 AND consumed_at IS NULL AND revoked_at IS NULL
             AND expires_at>clock_timestamp() AND NOT (token_key_id=ANY($2::text[]))
           LIMIT 1`,
          [purpose, Object.keys(k.challenge.keys)],
        )
      ).rowCount
    )
      throw notReady('identity challenge key unavailable');
    const digests = challengeDigests(k, purpose, raw);
    const row = (
      await client.query<Challenge>(
        'SELECT * FROM identity_challenges WHERE purpose=$1 AND token_digest=ANY($2::bytea[])',
        [purpose, digests.map((item) => item.digest)],
      )
    ).rows[0];
    if (!row) conflict('TOKEN_INVALID');
    return row;
  }
  async function lockedChallenge(client: PoolClient, candidate: Challenge): Promise<Challenge> {
    const row = (
      await client.query<Challenge>('SELECT * FROM identity_challenges WHERE id=$1 FOR UPDATE', [
        candidate.id,
      ])
    ).rows[0];
    if (
      !row ||
      row.consumed_at ||
      row.revoked_at ||
      row.expires_at.getTime() <= (await now(client)).getTime()
    )
      conflict('TOKEN_INVALID');
    return row;
  }
  async function invitationView(client: PoolClient, row: Invitation): Promise<InvitationView> {
    const delivery = (
      await client.query<{ id: string; status: DeliveryView['status']; updated_at: Date }>(
        `SELECT d.id,d.status,d.updated_at FROM identity_mail_deliveries d JOIN identity_challenges c ON c.id=d.challenge_id WHERE c.invitation_id=$1 AND c.generation=$2 AND c.purpose='invitation'`,
        [row.id, row.generation],
      )
    ).rows[0];
    if (!delivery) throw notReady('invitation delivery unavailable');
    const state =
      row.state === 'pending' && row.expires_at.getTime() <= (await now(client)).getTime()
        ? 'expired'
        : row.state;
    return {
      id: row.id,
      masked_email: row.masked_email,
      state,
      generation: Number(row.generation),
      created_at: iso(row.created_at),
      expires_at: iso(row.expires_at),
      accepted_at: row.accepted_at ? iso(row.accepted_at) : null,
      revoked_at: row.revoked_at ? iso(row.revoked_at) : null,
      delivery: {
        delivery_id: delivery.id,
        status: delivery.status,
        updated_at: iso(delivery.updated_at),
      },
    };
  }
  function cursor(
    actor: Actor,
    collection: string,
    position: { created_at: Date; id: string; created_at_cursor?: string },
  ) {
    if (!secret) throw notReady('authentication unavailable');
    const body = Buffer.from(
      JSON.stringify({
        actor: actor.ownerId,
        collection,
        at: position.created_at_cursor ?? iso(position.created_at),
        id: position.id,
      }),
    ).toString('base64url');
    return `${body}.${createHmac('sha256', secret).update(`identity:cursor:${body}`).digest('base64url')}`;
  }
  function page(actor: Actor, collection: string, query: unknown) {
    const parsed = parse(schemas.query, query);
    let after: { at: string; id: string } | null = null;
    if (parsed.cursor) {
      try {
        const [body, signature, ...rest] = parsed.cursor.split('.');
        if (!body || !signature || rest.length || !secret) throw Error();
        const expected = createHmac('sha256', secret).update(`identity:cursor:${body}`).digest();
        const actual = Buffer.from(signature, 'base64url');
        if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw Error();
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        if (
          payload.actor !== actor.ownerId ||
          payload.collection !== collection ||
          !isUuid(payload.id) ||
          typeof payload.at !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(payload.at) ||
          !Number.isFinite(new Date(payload.at).getTime())
        )
          throw Error();
        after = { at: payload.at, id: payload.id };
      } catch {
        throw validationError('invalid cursor');
      }
    }
    return { limit: parsed.limit ?? 20, after };
  }
  async function actionReplay(
    client: PoolClient,
    actor: Actor,
    action: string,
    key: string,
    k: IdentityKeyring,
    request: string,
  ): Promise<InvitationView | null> {
    const row = (
      await client.query<{
        request_digest: Buffer;
        request_key_id: string;
        response_snapshot: InvitationView;
        replay_until: Date;
      }>(
        'SELECT request_digest,request_key_id,response_snapshot,replay_until FROM identity_action_keys WHERE actor_id=$1 AND action=$2 AND key=$3',
        [actor.ownerId, action, key],
      )
    ).rows[0];
    if (!row) return null;
    if (row.replay_until.getTime() <= (await now(client)).getTime())
      conflict('IDEMPOTENCY_EXPIRED');
    if (!row.request_digest.equals(tokenDigest(k, 'invitation', request, row.request_key_id)))
      conflict('IDEMPOTENCY_MISMATCH');
    return row.response_snapshot;
  }
  async function recordAction(
    client: PoolClient,
    actor: Actor,
    action: string,
    key: string,
    k: IdentityKeyring,
    request: string,
    snapshot: InvitationView,
  ) {
    await client.query(
      `INSERT INTO identity_action_keys(actor_id,action,key,request_digest,request_key_id,invitation_id,generation,delivery_id,response_snapshot,created_at,replay_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp(),clock_timestamp()+interval '7 days')`,
      [
        actor.ownerId,
        action,
        key,
        tokenDigest(k, 'invitation', request),
        k.challenge.active,
        snapshot.id,
        snapshot.generation,
        snapshot.delivery.delivery_id,
        snapshot,
      ],
    );
  }
  async function closePending(client: PoolClient, digest: Buffer) {
    const rows = (
      await client.query<{ id: string }>(
        `UPDATE identity_invitations SET state='expired',updated_at=clock_timestamp() WHERE lookup_digest=$1 AND state='pending' AND expires_at<=clock_timestamp() RETURNING id`,
        [digest],
      )
    ).rows;
    for (const row of rows) await revokeChallenges(client, 'invitation_id=$1', [row.id]);
  }

  return {
    async account(actor: Actor) {
      return tx(async (client) => {
        const user = await actorUser(client, actor);
        const c = await contact(client, actor.ownerId);
        const pending = (
          await client.query(
            `SELECT c.masked_email,c.expires_at,d.id delivery_id,d.status,d.updated_at FROM identity_challenges c JOIN identity_account_admissions a ON a.user_id=c.user_id AND a.contact_generation=c.generation JOIN identity_mail_deliveries d ON d.challenge_id=c.id WHERE c.user_id=$1 AND c.purpose='verify_contact' AND c.consumed_at IS NULL AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()`,
            [actor.ownerId],
          )
        ).rows[0];
        const state = getWorkspaceAccountStatus().state;
        const count = listWorkspaces(actor.ownerId).length;
        return {
          user: { id: user.id, display_name: user.display_name },
          account_status: 'active' as const,
          installation_admin: !!(
            await client.query('SELECT 1 FROM installation_admin WHERE user_id=$1', [actor.ownerId])
          ).rowCount,
          contact: {
            state: c ? ('verified' as const) : ('unbound' as const),
            masked_email: c?.masked_email ?? null,
            verified_at: c ? iso(c.verified_at) : null,
          },
          pending_contact: pending
            ? {
                masked_email: pending.masked_email,
                expires_at: iso(pending.expires_at),
                delivery: {
                  delivery_id: pending.delivery_id,
                  status: pending.status,
                  updated_at: iso(pending.updated_at),
                },
              }
            : null,
          workspace: {
            count,
            state:
              state === 'invalid' || state === 'unreadable'
                ? ('unavailable' as const)
                : count
                  ? ('available' as const)
                  : ('none' as const),
          },
        };
      });
    },
    async requestContact(actor: Actor, input: unknown, ip: string) {
      const data = parse(schemas.contact, input),
        k = keys(),
        address = normalizeContactEmail(data.email);
      mailReady();
      await quota('contact_request', ip, { actor: actor.ownerId, address: address.normalized });
      const digest = lookupDigest(k, address.normalized);
      return tx(async (client) => {
        await requireLookupKey(client, k);
        await addressLock(client, digest);
        await lockUsers(client, [actor.ownerId]);
        await actorUser(client, actor);
        await verifyPassword(client, actor.ownerId, data.current_password);
        if (
          (
            await client.query(
              'SELECT 1 FROM identity_contacts WHERE lookup_digest=$1 AND user_id<>$2',
              [digest, actor.ownerId],
            )
          ).rowCount
        )
          conflict('CONTACT_UNAVAILABLE');
        await revokeChallenges(client, "user_id=$1 AND purpose='verify_contact'", [actor.ownerId]);
        const generation = Number(
          (
            await client.query<{ contact_generation: string }>(
              'UPDATE identity_account_admissions SET contact_generation=contact_generation+1 WHERE user_id=$1 RETURNING contact_generation',
              [actor.ownerId],
            )
          ).rows[0]!.contact_generation,
        );
        const delivery = await issueChallenge(client, k, {
          purpose: 'verify_contact',
          userId: actor.ownerId,
          digest,
          generation,
          address: address.address,
          masked: address.masked,
          at: await now(client),
        });
        return { contact_state: 'pending' as const, delivery };
      });
    },
    async verifyContact(actor: Actor, input: unknown, ip: string) {
      const k = keys();
      await quota('contact_verify', ip, { actor: actor.ownerId, token: quotaToken(input) });
      const data = parse(schemas.verify, input);
      return tx(async (client) => {
        await requireLookupKey(client, k);
        const candidate = await findChallenge(client, k, 'verify_contact', data.token);
        if (candidate.user_id !== actor.ownerId) throw forbidden();
        await addressLock(client, candidate.lookup_digest);
        await lockUsers(client, [actor.ownerId]);
        await actorUser(client, actor);
        await client.query(
          "SELECT id FROM identity_invitations WHERE lookup_digest=$1 AND state='pending' ORDER BY id FOR UPDATE",
          [candidate.lookup_digest],
        );
        const c = await lockedChallenge(client, candidate);
        const a = (
          await client.query<{ contact_generation: string }>(
            'SELECT contact_generation FROM identity_account_admissions WHERE user_id=$1',
            [actor.ownerId],
          )
        ).rows[0]!;
        if (Number(a.contact_generation) !== Number(c.generation)) conflict('TOKEN_INVALID');
        if (
          (
            await client.query(
              'SELECT 1 FROM identity_contacts WHERE lookup_digest=$1 AND user_id<>$2',
              [c.lookup_digest, actor.ownerId],
            )
          ).rowCount
        )
          conflict('CONTACT_UNAVAILABLE');
        if (
          !c.candidate_ciphertext ||
          !c.candidate_nonce ||
          !c.candidate_tag ||
          !c.encryption_key_id
        )
          throw notReady('contact encryption unavailable');
        const address = openIdentity(
          k,
          {
            ciphertext: c.candidate_ciphertext,
            nonce: c.candidate_nonce,
            tag: c.candidate_tag,
            encryption_key_id: c.encryption_key_id,
          },
          `identity:challenge:${c.id}:${actor.ownerId}:verify_contact:${c.generation}`,
        );
        await putContact(client, k, actor.ownerId, address, c.lookup_digest, c.masked_email!);
        const pending = (
          await client.query<{ id: string }>(
            "UPDATE identity_invitations SET state='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE lookup_digest=$1 AND state='pending' RETURNING id",
            [c.lookup_digest],
          )
        ).rows;
        for (const invitation of pending)
          await revokeChallenges(client, 'invitation_id=$1', [invitation.id]);
        await client.query(
          'UPDATE identity_challenges SET consumed_at=clock_timestamp(),candidate_ciphertext=NULL,candidate_nonce=NULL,candidate_tag=NULL,encryption_key_id=NULL WHERE id=$1',
          [c.id],
        );
        await revokeChallenges(client, "user_id=$1 AND purpose='reset_password'", [actor.ownerId]);
        return { contact_state: 'verified' as const };
      });
    },
    async listInvitations(actor: Actor, query: unknown) {
      const p = page(actor, 'invitations', query);
      return tx(async (client) => {
        await actorUser(client, actor, true);
        const rows = (
          await client.query<Invitation>(
            `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at_cursor FROM identity_invitations WHERE created_by=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,
            [actor.ownerId, p.after?.at ?? null, p.after?.id ?? null, p.limit + 1],
          )
        ).rows;
        const more = rows.length > p.limit;
        const visible = rows.slice(0, p.limit);
        return {
          items: await Promise.all(visible.map((row) => invitationView(client, row))),
          next_cursor: more ? cursor(actor, 'invitations', visible.at(-1)!) : null,
        };
      });
    },
    async createInvitation(actor: Actor, input: unknown, ip: string) {
      const data = parse(schemas.invite, input),
        k = keys(),
        address = normalizeContactEmail(data.email);
      mailReady();
      await quota('invite_create', ip, { actor: actor.ownerId, address: address.normalized });
      const digest = lookupDigest(k, address.normalized),
        request = `action:invite_create:${address.normalized}`;
      return tx(async (client) => {
        await requireLookupKey(client, k);
        await addressLock(client, digest);
        await lockUsers(client, [actor.ownerId]);
        await actorUser(client, actor, true);
        await verifyPassword(client, actor.ownerId, data.current_password);
        if (!(await contact(client, actor.ownerId))) conflict('CONTACT_VERIFICATION_REQUIRED');
        const replay = await actionReplay(
          client,
          actor,
          'invite_create',
          data.idempotency_key,
          k,
          request,
        );
        if (replay) return { invitation: replay, replayed: true };
        await closePending(client, digest);
        if (
          (
            await client.query(
              "SELECT 1 FROM identity_contacts WHERE lookup_digest=$1 UNION ALL SELECT 1 FROM identity_invitations WHERE lookup_digest=$1 AND state='pending'",
              [digest],
            )
          ).rowCount
        )
          conflict('CONTACT_UNAVAILABLE');
        const invitationId = randomUUID(),
          at = await now(client),
          expiresAt = new Date(at.getTime() + 48 * 3600000),
          sealed = sealIdentity(k, address.address, `identity:invitation:${invitationId}`);
        const row = (
          await client.query<Invitation>(
            `INSERT INTO identity_invitations(id,created_by,lookup_digest,lookup_key_id,address_ciphertext,address_nonce,address_tag,encryption_key_id,masked_email,state,generation,created_at,updated_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',1,$10,$10,$11) RETURNING *`,
            [
              invitationId,
              actor.ownerId,
              digest,
              k.lookup.id,
              sealed.ciphertext,
              sealed.nonce,
              sealed.tag,
              sealed.encryption_key_id,
              address.masked,
              at,
              expiresAt,
            ],
          )
        ).rows[0]!;
        await issueChallenge(client, k, {
          purpose: 'invitation',
          invitationId,
          digest,
          generation: 1,
          address: address.address,
          at,
        });
        const invitation = await invitationView(client, row);
        await recordAction(
          client,
          actor,
          'invite_create',
          data.idempotency_key,
          k,
          request,
          invitation,
        );
        return { invitation, replayed: false };
      });
    },
    async resendInvitation(actor: Actor, invitationId: string, input: unknown, ip: string) {
      id(invitationId);
      const data = parse(schemas.resend, input),
        k = keys();
      mailReady();
      // Read only the encrypted target for quota; mutation always rechecks after address/user locks.
      const initial = await tx(async (client) => {
        await requireLookupKey(client, k);
        await actorUser(client, actor, true);
        return (
          await client.query<Invitation>(
            'SELECT * FROM identity_invitations WHERE id=$1 AND created_by=$2',
            [invitationId, actor.ownerId],
          )
        ).rows[0];
      });
      const address =
        initial?.address_ciphertext && (initial.state === 'pending' || initial.state === 'expired')
          ? normalizeContactEmail(invitationAddress(k, initial))
          : undefined;
      await quota('invite_resend', ip, {
        actor: actor.ownerId,
        ...(address ? { address: address.normalized } : {}),
      });
      if (!initial) throw notFound();
      const digest = address ? lookupDigest(k, address.normalized) : initial.lookup_digest;
      const request = `action:invite_resend:${invitationId}`;
      return tx(async (client) => {
        await requireLookupKey(client, k);
        await addressLock(client, digest);
        await lockUsers(client, [actor.ownerId]);
        await actorUser(client, actor, true);
        await verifyPassword(client, actor.ownerId, data.current_password);
        const replay = await actionReplay(
          client,
          actor,
          'invite_resend',
          data.idempotency_key,
          k,
          request,
        );
        if (replay) return { invitation: replay };
        const row = (
          await client.query<Invitation>(
            'SELECT * FROM identity_invitations WHERE id=$1 AND created_by=$2 FOR UPDATE',
            [invitationId, actor.ownerId],
          )
        ).rows[0];
        if (!row) throw notFound();
        if (row.state !== 'pending' && row.state !== 'expired') conflict('INVITATION_CLOSED');
        if (!address) conflict('INVITATION_CLOSED');
        await closePending(client, digest);
        if (
          (
            await client.query(
              "SELECT 1 FROM identity_contacts WHERE lookup_digest=$1 UNION ALL SELECT 1 FROM identity_invitations WHERE lookup_digest=$1 AND state='pending' AND id<>$2",
              [digest, row.id],
            )
          ).rowCount
        )
          conflict('CONTACT_UNAVAILABLE');
        await revokeChallenges(client, 'invitation_id=$1', [row.id]);
        const generation = Number(row.generation) + 1,
          at = await now(client),
          expiresAt = new Date(at.getTime() + 48 * 3600000);
        const updated = (
          await client.query<Invitation>(
            "UPDATE identity_invitations SET state='pending',lookup_digest=$5,lookup_key_id=$6,generation=$2,expires_at=$3,updated_at=$4 WHERE id=$1 RETURNING *",
            [row.id, generation, expiresAt, at, digest, k.lookup.id],
          )
        ).rows[0]!;
        await issueChallenge(client, k, {
          purpose: 'invitation',
          invitationId: row.id,
          digest,
          generation,
          address: invitationAddress(k, row),
          at,
        });
        const invitation = await invitationView(client, updated);
        await recordAction(
          client,
          actor,
          'invite_resend',
          data.idempotency_key,
          k,
          request,
          invitation,
        );
        return { invitation };
      });
    },
    async revokeInvitation(actor: Actor, invitationId: string, input: unknown, ip: string) {
      id(invitationId);
      const data = parse(schemas.revoke, input);
      await quota('password_write', ip, { actor: actor.ownerId });
      return tx(async (client) => {
        const initial = (
          await client.query<Invitation>(
            'SELECT * FROM identity_invitations WHERE id=$1 AND created_by=$2',
            [invitationId, actor.ownerId],
          )
        ).rows[0];
        if (!initial) {
          await lockUsers(client, [actor.ownerId]);
          await actorUser(client, actor, true);
          throw notFound();
        }
        await addressLock(client, initial.lookup_digest);
        await lockUsers(client, [actor.ownerId]);
        await actorUser(client, actor, true);
        await verifyPassword(client, actor.ownerId, data.current_password);
        const row = (
          await client.query<Invitation>(
            'SELECT * FROM identity_invitations WHERE id=$1 FOR UPDATE',
            [invitationId],
          )
        ).rows[0]!;
        if (row.state === 'accepted') conflict('INVITATION_CLOSED');
        if (row.state !== 'revoked')
          await client.query(
            "UPDATE identity_invitations SET state='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",
            [row.id],
          );
        await revokeChallenges(client, 'invitation_id=$1', [row.id]);
        return { revoked: true as const };
      });
    },
    async acceptInvitation(input: unknown, ip: string, existingActor?: Actor | null) {
      const k = keys();
      await quota('accept', ip, { token: quotaToken(input) });
      const data = parse(schemas.accept, input);
      if (existingActor?.sessionId) conflict('SIGN_OUT_REQUIRED');
      return tx(async (client) => {
        await requireLookupKey(client, k);
        const candidate = await findChallenge(client, k, 'invitation', data.token);
        await addressLock(client, candidate.lookup_digest);
        const invitation = (
          await client.query<Invitation>(
            'SELECT * FROM identity_invitations WHERE id=$1 FOR UPDATE',
            [candidate.invitation_id],
          )
        ).rows[0];
        const c = await lockedChallenge(client, candidate),
          at = await now(client);
        if (
          !invitation ||
          invitation.state !== 'pending' ||
          Number(invitation.generation) !== Number(c.generation) ||
          invitation.expires_at.getTime() <= at.getTime() ||
          !invitation.lookup_digest.equals(c.lookup_digest) ||
          (
            await client.query('SELECT 1 FROM identity_contacts WHERE lookup_digest=$1', [
              c.lookup_digest,
            ])
          ).rowCount
        )
          conflict('TOKEN_INVALID');
        const authEmail = deriveAuthEmail(data.login_name, secret);
        if ((await client.query('SELECT 1 FROM users WHERE auth_email=$1', [authEmail])).rowCount)
          conflict('LOGIN_NAME_UNAVAILABLE');
        // Serializes competing invitation usernames without taking an installation-wide lock.
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
          createHmac('sha256', secret!)
            .update(`identity:username:${authEmail}`)
            .digest()
            .readBigInt64BE()
            .toString(),
        ]);
        if ((await client.query('SELECT 1 FROM users WHERE auth_email=$1', [authEmail])).rowCount)
          conflict('LOGIN_NAME_UNAVAILABLE');
        const context = await library(client).$context;
        const user = await context.adapter.create<{ id: string }>({
          model: 'user',
          data: {
            name: data.display_name,
            email: authEmail,
            emailVerified: false,
            createdAt: at,
            updatedAt: at,
          },
        });
        await context.adapter.create({
          model: 'account',
          data: {
            userId: user.id,
            providerId: 'credential',
            accountId: user.id,
            password: await context.password.hash(data.password),
            createdAt: at,
            updatedAt: at,
          },
        });
        await client.query(
          "INSERT INTO identity_account_admissions(user_id,source,invitation_id,admitted_at) VALUES($1,'invitation',$2,$3)",
          [user.id, invitation.id, at],
        );
        const address = invitationAddress(k, invitation);
        await putContact(client, k, user.id, address, c.lookup_digest, invitation.masked_email);
        await client.query(
          'UPDATE identity_challenges SET consumed_at=clock_timestamp() WHERE id=$1',
          [c.id],
        );
        await client.query(
          "UPDATE identity_invitations SET state='accepted',accepted_user_id=$2,accepted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",
          [invitation.id, user.id],
        );
        return { account_created: true as const, authenticated: false as const };
      });
    },
    async forgotPassword(input: unknown, ip: string) {
      const data = parse(schemas.forgot, input),
        k = keys(),
        address = normalizeContactEmail(data.email);
      mailReady();
      await quota('forgot', ip, { address: address.normalized });
      const digest = lookupDigest(k, address.normalized);
      return tx(async (client) => {
        await requireLookupKey(client, k);
        // Configuration failure is global: an anonymous address must not select
        // whether a missing historical contact key becomes visible as 503.
        if (
          (
            await client.query(
              'SELECT 1 FROM identity_contacts WHERE NOT (encryption_key_id=ANY($1::text[])) LIMIT 1',
              [Object.keys(k.encryption.keys)],
            )
          ).rowCount
        )
          throw notReady('identity contact key unavailable');
        await addressLock(client, digest);
        const initial = (
          await client.query<Contact>('SELECT * FROM identity_contacts WHERE lookup_digest=$1', [
            digest,
          ])
        ).rows[0];
        if (!initial) return { accepted: true as const };
        await lockUsers(client, [initial.user_id]);
        const eligible = (
          await client.query(
            "SELECT 1 FROM users u JOIN identity_account_admissions a ON a.user_id=u.id WHERE u.id=$1 AND u.status='active'",
            [initial.user_id],
          )
        ).rowCount;
        const c = await contact(client, initial.user_id);
        if (!eligible || !c || !c.lookup_digest.equals(digest)) return { accepted: true as const };
        await revokeChallenges(client, "user_id=$1 AND purpose='reset_password'", [c.user_id]);
        const generation = Number(
          (
            await client.query<{ reset_generation: string }>(
              'UPDATE identity_account_admissions SET reset_generation=reset_generation+1 WHERE user_id=$1 RETURNING reset_generation',
              [c.user_id],
            )
          ).rows[0]!.reset_generation,
        );
        await issueChallenge(client, k, {
          purpose: 'reset_password',
          userId: c.user_id,
          digest,
          generation,
          address: contactAddress(k, c),
          contactRevision: Number(c.revision),
          at: await now(client),
        });
        return { accepted: true as const };
      });
    },
    async resetPassword(input: unknown, ip: string) {
      const k = keys();
      await quota('reset', ip, { token: quotaToken(input) });
      const data = parse(schemas.reset, input);
      return tx(async (client) => {
        await requireLookupKey(client, k);
        const candidate = await findChallenge(client, k, 'reset_password', data.token);
        await addressLock(client, candidate.lookup_digest);
        await lockUsers(client, [candidate.user_id!]);
        const c = await lockedChallenge(client, candidate);
        const a = (
          await client.query<{ reset_generation: string }>(
            "SELECT a.reset_generation FROM identity_account_admissions a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1 AND u.status='active'",
            [c.user_id],
          )
        ).rows[0];
        const contactRow = await contact(client, c.user_id!);
        if (
          !a ||
          Number(a.reset_generation) !== Number(c.generation) ||
          !contactRow ||
          Number(contactRow.revision) !== Number(c.contact_revision) ||
          !contactRow.lookup_digest.equals(c.lookup_digest)
        )
          conflict('TOKEN_INVALID');
        const context = await library(client).$context;
        const credential = (
          await client.query<{ id: string; account_id: string; password_hash: string | null }>(
            'SELECT id,account_id,password_hash FROM auth_accounts WHERE user_id=$1',
            [c.user_id],
          )
        ).rows;
        if (
          credential.length !== 1 ||
          credential[0]!.account_id !== c.user_id ||
          !credential[0]!.password_hash
        )
          conflict('TOKEN_INVALID');
        await context.adapter.update({
          model: 'account',
          where: [{ field: 'id', value: credential[0]!.id }],
          update: {
            password: await context.password.hash(data.new_password),
            updatedAt: await now(client),
          },
        });
        await client.query(
          'UPDATE identity_challenges SET consumed_at=clock_timestamp() WHERE id=$1',
          [c.id],
        );
        await invalidateUser(client, c.user_id!);
        return { password_changed: true as const, authenticated: false as const };
      });
    },
    async changePassword(actor: Actor, input: unknown, headers: Headers, ip: string) {
      const data = parse(schemas.change, input);
      await quota('password_write', ip, { actor: actor.ownerId });
      await tx(async (client) => {
        await lockUsers(client, [actor.ownerId]);
        await actorUser(client, actor);
        const credential = await verifyPassword(client, actor.ownerId, data.current_password);
        const context = await library(client).$context;
        await context.adapter.update({
          model: 'account',
          where: [{ field: 'id', value: credential.id }],
          update: {
            password: await context.password.hash(data.new_password),
            updatedAt: await now(client),
          },
        });
        await invalidateUser(client, actor.ownerId);
      });
      return { cookies: await clearCookies(headers) };
    },
    async sessions(actor: Actor, query: unknown) {
      const p = page(actor, 'sessions', query);
      return tx(async (client) => {
        await actorUser(client, actor);
        const rows = (
          await client.query<{
            id: string;
            created_at: Date;
            created_at_cursor: string;
            expires_at: Date;
            revoked_at: Date | null;
            user_agent: string | null;
          }>(
            `SELECT id,created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at_cursor,expires_at,revoked_at,user_agent FROM sessions WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,
            [actor.ownerId, p.after?.at ?? null, p.after?.id ?? null, p.limit + 1],
          )
        ).rows;
        const visible = rows.slice(0, p.limit);
        return {
          items: visible.map((row) => ({
            id: row.id,
            created_at: iso(row.created_at),
            expires_at: iso(row.expires_at),
            revoked_at: row.revoked_at ? iso(row.revoked_at) : null,
            current: row.id === actor.sessionId,
            device_summary: row.user_agent?.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 128) || null,
          })),
          next_cursor: rows.length > p.limit ? cursor(actor, 'sessions', visible.at(-1)!) : null,
        };
      });
    },
    async revokeSession(actor: Actor, sessionId: string, headers: Headers) {
      id(sessionId);
      await tx(async (client) => {
        await lockUsers(client, [actor.ownerId]);
        await actorUser(client, actor);
        if (
          !(
            await client.query(
              'UPDATE sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND user_id=$2 RETURNING id',
              [sessionId, actor.ownerId],
            )
          ).rowCount
        )
          throw notFound();
      });
      const signedOut = sessionId === actor.sessionId;
      return { signed_out: signedOut, cookies: signedOut ? await clearCookies(headers) : [] };
    },
    async revokeSessions(actor: Actor, input: unknown, headers: Headers, ip: string) {
      const data = parse(schemas.sessions, input);
      await quota('password_write', ip, { actor: actor.ownerId });
      await tx(async (client) => {
        await lockUsers(client, [actor.ownerId]);
        await actorUser(client, actor);
        await verifyPassword(client, actor.ownerId, data.current_password);
        await client.query(
          "UPDATE sessions SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=$1 AND ($2='all' OR id<>$3)",
          [actor.ownerId, data.scope, actor.sessionId],
        );
      });
      const signedOut = data.scope === 'all';
      return { signed_out: signedOut, cookies: signedOut ? await clearCookies(headers) : [] };
    },
    async users(actor: Actor, query: unknown) {
      const p = page(actor, 'users', query);
      return tx(async (client) => {
        await actorUser(client, actor, true);
        const rows = (
          await client.query<
            Omit<ManagedAccountView, 'created_at'> & { created_at: Date; created_at_cursor: string }
          >(
            `SELECT u.id,u.display_name,u.status,(a.user_id IS NOT NULL) admitted,(b.user_id IS NOT NULL) installation_admin,c.masked_email,u.created_at,to_char(u.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at_cursor FROM users u LEFT JOIN identity_account_admissions a ON a.user_id=u.id LEFT JOIN installation_admin b ON b.user_id=u.id LEFT JOIN identity_contacts c ON c.user_id=u.id WHERE ($1::timestamptz IS NULL OR (u.created_at,u.id)<($1::timestamptz,$2::uuid)) ORDER BY u.created_at DESC,u.id DESC LIMIT $3`,
            [p.after?.at ?? null, p.after?.id ?? null, p.limit + 1],
          )
        ).rows;
        const visible = rows.slice(0, p.limit);
        return {
          items: visible.map((row) => ({
            id: row.id,
            display_name: row.display_name,
            status: row.status,
            admitted: row.admitted,
            installation_admin: row.installation_admin,
            masked_email: row.masked_email,
            created_at: iso(row.created_at),
          })),
          next_cursor: rows.length > p.limit ? cursor(actor, 'users', visible.at(-1)!) : null,
        };
      });
    },
    async disableUser(actor: Actor, userId: string, input: unknown, ip: string) {
      id(userId);
      const data = parse(schemas.disable, input);
      await quota('password_write', ip, { actor: actor.ownerId });
      return tx(async (client) => {
        await lockUsers(client, [actor.ownerId, userId]);
        await actorUser(client, actor, true);
        await verifyPassword(client, actor.ownerId, data.current_password);
        if (
          (await client.query('SELECT 1 FROM installation_admin WHERE user_id=$1', [userId]))
            .rowCount
        )
          conflict('SOLE_ADMIN_PROTECTED');
        const target = (await client.query<User>('SELECT * FROM users WHERE id=$1', [userId]))
          .rows[0];
        if (!target) throw notFound();
        if (target.status === 'disabled') return { disabled: true as const };
        if (target.status !== 'active') throw notFound();
        await client.query(
          "UPDATE users SET status='disabled',updated_at=clock_timestamp() WHERE id=$1",
          [userId],
        );
        await invalidateUser(client, userId);
        return { disabled: true as const };
      });
    },
    async requestDeletion(actor: Actor, input: unknown, headers: Headers, ip: string) {
      const data = parse(schemas.disable, input);
      await quota('password_write', ip, { actor: actor.ownerId });
      await tx(async (client) => {
        await lockUsers(client, [actor.ownerId]);
        await actorUser(client, actor);
        await verifyPassword(client, actor.ownerId, data.current_password);
        if (
          (await client.query('SELECT 1 FROM installation_admin WHERE user_id=$1', [actor.ownerId]))
            .rowCount
        )
          conflict('SOLE_ADMIN_PROTECTED');
        await client.query(
          "UPDATE users SET status='deleted_requested',updated_at=clock_timestamp() WHERE id=$1",
          [actor.ownerId],
        );
        await invalidateUser(client, actor.ownerId);
      });
      return { cookies: await clearCookies(headers) };
    },
  };
}
