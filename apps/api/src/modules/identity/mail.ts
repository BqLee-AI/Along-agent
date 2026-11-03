import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { notReady } from '../../http/errors.js';
import {
  loadIdentityKeyring,
  normalizeContactEmail,
  openIdentity,
  sealIdentity,
  type IdentityKeyring,
  type Purpose,
} from './email-security.js';

export interface IdentityMailMessage {
  deliveryId: string;
  to: string;
  subject: string;
  text: string;
}
export type IdentityMailResult =
  | { status: 'submitted'; acceptanceId?: string }
  | { status: 'failed'; failureCode: 'provider_rejected' }
  | { status: 'unknown'; failureCode: 'transport_unknown' | 'provider_unknown' };
export type IdentityMailSender = (
  message: IdentityMailMessage,
  signal: AbortSignal,
) => Promise<IdentityMailResult>;
export interface IdentityMailConfig {
  origin: string;
  from: string;
  send: IdentityMailSender;
  timeoutMs?: number;
}
export interface IdentityMailOptions {
  keys?: IdentityKeyring;
  mail?: IdentityMailConfig;
}
export interface IdentityDeliveryView {
  delivery_id: string;
  status: 'queued' | 'submitting' | 'submitted' | 'failed' | 'unknown' | 'suppressed';
  updated_at: string;
}
export interface EnqueueIdentityMailInput {
  challengeId: string;
  purpose: Purpose;
  generation: number;
  to: string;
  token: string;
  expiresAt: Date;
}
interface DeliveryRow {
  id: string;
  challenge_id: string;
  purpose: Purpose;
  generation: string;
  payload_ciphertext: Buffer;
  payload_nonce: Buffer;
  payload_tag: Buffer;
  encryption_key_id: string;
}
interface ChallengeRow {
  id: string;
  user_id: string | null;
  invitation_id: string | null;
  purpose: Purpose;
  generation: string;
  contact_revision: string | null;
  lookup_digest: Buffer;
}
const PATHS: Record<Purpose, string> = {
  invitation: '/invite',
  verify_contact: '/verify-contact',
  reset_password: '/reset-password',
};
const SUBJECTS: Record<Purpose, string> = {
  invitation: 'Your Along account invitation',
  verify_contact: 'Verify your Along contact email',
  reset_password: 'Reset your Along password',
};
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Explicit endpoint injection is solely for isolated protocol simulators; env configuration uses Resend HTTPS only. */
export function createResendIdentitySender(options: {
  apiKey: string;
  from: string;
  endpoint?: string;
}): IdentityMailSender {
  const endpoint = new URL(options.endpoint ?? 'https://api.resend.com/emails');
  if (
    endpoint.protocol !== 'https:' &&
    !(
      endpoint.protocol === 'http:' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
    )
  )
    throw notReady('identity mail endpoint unavailable');
  if (endpoint.username || endpoint.password || endpoint.hash)
    throw notReady('identity mail endpoint unavailable');
  return async (message, signal) => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.deliveryId,
        },
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return response.status >= 400 && response.status < 500 && response.status !== 408
          ? { status: 'failed', failureCode: 'provider_rejected' }
          : { status: 'unknown', failureCode: 'provider_unknown' };
      }
      const reader = response.body?.getReader();
      if (!reader) return { status: 'unknown', failureCode: 'provider_unknown' };
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 16384) {
          await reader.cancel();
          return { status: 'unknown', failureCode: 'provider_unknown' };
        }
        chunks.push(item.value);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const acceptanceId = body && typeof body === 'object' && 'id' in body ? body.id : undefined;
      if (typeof acceptanceId !== 'string' || !SAFE_PROVIDER_ID.test(acceptanceId))
        return { status: 'unknown', failureCode: 'provider_unknown' };
      return { status: 'submitted', acceptanceId };
    } catch {
      return { status: 'unknown', failureCode: 'transport_unknown' };
    }
  };
}
export function loadIdentityMailConfig(): IdentityMailConfig {
  try {
    const {
      APP_ORIGIN: origin,
      IDENTITY_MAIL_PROVIDER: provider,
      IDENTITY_MAIL_FROM: from,
      IDENTITY_MAIL_API_KEY: apiKey,
    } = process.env;
    if (
      !origin ||
      provider !== 'resend' ||
      !from ||
      !apiKey ||
      apiKey.length > 4096 ||
      /[\r\n]/.test(apiKey)
    )
      throw new Error('missing configuration');
    const config: IdentityMailConfig = {
      origin,
      from,
      send: createResendIdentitySender({ apiKey, from }),
      timeoutMs: 10000,
    };
    return requireIdentityMailReady({ mail: config });
  } catch {
    throw notReady('identity mail configuration unavailable');
  }
}
export function requireIdentityMailReady(
  options: { mail?: IdentityMailConfig } = {},
): IdentityMailConfig {
  const mail = options.mail ?? loadIdentityMailConfig();
  try {
    const origin = new URL(mail.origin);
    if (
      origin.origin !== mail.origin ||
      origin.username ||
      origin.password ||
      (origin.protocol !== 'https:' &&
        !(
          origin.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
        ))
    )
      throw new Error('invalid origin');
    normalizeContactEmail(mail.from);
    if (
      typeof mail.send !== 'function' ||
      (mail.timeoutMs !== undefined &&
        (!Number.isInteger(mail.timeoutMs) || mail.timeoutMs < 1 || mail.timeoutMs > 30000))
    )
      throw new Error('invalid transport');
    return mail;
  } catch {
    throw notReady('identity mail configuration unavailable');
  }
}
export async function enqueueIdentityMail(
  client: PoolClient,
  keys: IdentityKeyring,
  input: EnqueueIdentityMailInput,
): Promise<IdentityDeliveryView> {
  const id = randomUUID();
  const to = normalizeContactEmail(input.to).address;
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(input.token) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    !Object.hasOwn(PATHS, input.purpose)
  )
    throw notReady('identity delivery context unavailable');
  const payload = sealIdentity(
    keys,
    JSON.stringify({ to, token: input.token, expiresAt: input.expiresAt.toISOString() }),
    `identity:delivery:${id}:${input.challengeId}:${input.purpose}:${input.generation}`,
  );
  const { rows } = await client.query<{ updated_at: Date }>(
    `INSERT INTO identity_mail_deliveries(id,challenge_id,purpose,generation,status,payload_ciphertext,payload_nonce,payload_tag,encryption_key_id,created_at,updated_at) VALUES($1,$2,$3,$4,'queued',$5,$6,$7,$8,clock_timestamp(),clock_timestamp()) RETURNING updated_at`,
    [
      id,
      input.challengeId,
      input.purpose,
      input.generation,
      payload.ciphertext,
      payload.nonce,
      payload.tag,
      payload.encryption_key_id,
    ],
  );
  return { delivery_id: id, status: 'queued', updated_at: rows[0]!.updated_at.toISOString() };
}

async function cleanIdentityMail(pool: Pool): Promise<void> {
  // Every maintenance statement is bounded; terminal history never retains an encrypted raw token.
  await pool.query(
    `WITH expired AS (SELECT id FROM identity_invitations WHERE state='pending' AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE identity_invitations i SET state='expired',updated_at=clock_timestamp() FROM expired WHERE i.id=expired.id`,
  );
  await pool.query(
    `WITH stale AS (SELECT id FROM identity_mail_deliveries WHERE status='submitting' AND updated_at<clock_timestamp()-interval '120 seconds' ORDER BY updated_at,id LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE identity_mail_deliveries d SET status='unknown',failure_code='abandoned_submitting',finished_at=clock_timestamp(),updated_at=clock_timestamp(),payload_ciphertext=NULL,payload_nonce=NULL,payload_tag=NULL,encryption_key_id=NULL,payload_erased_at=clock_timestamp() FROM stale WHERE d.id=stale.id`,
  );
  await pool.query(
    `WITH expired AS (SELECT d.id FROM identity_mail_deliveries d JOIN identity_challenges c ON c.id=d.challenge_id WHERE d.payload_ciphertext IS NOT NULL AND (d.status IN ('submitted','failed','unknown','suppressed') OR c.expires_at<clock_timestamp()-interval '24 hours') ORDER BY d.created_at,d.id LIMIT 100 FOR UPDATE OF d SKIP LOCKED) UPDATE identity_mail_deliveries d SET payload_ciphertext=NULL,payload_nonce=NULL,payload_tag=NULL,encryption_key_id=NULL,payload_erased_at=clock_timestamp() FROM expired WHERE d.id=expired.id`,
  );
  await pool.query(
    `WITH expired AS (SELECT id FROM identity_challenges WHERE candidate_ciphertext IS NOT NULL AND (consumed_at IS NOT NULL OR expires_at<clock_timestamp()-interval '24 hours') ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE identity_challenges c SET candidate_ciphertext=NULL,candidate_nonce=NULL,candidate_tag=NULL,encryption_key_id=NULL FROM expired WHERE c.id=expired.id`,
  );
  await pool.query(
    `WITH expired AS (SELECT id FROM identity_challenges WHERE COALESCE(consumed_at,revoked_at,expires_at)<clock_timestamp()-interval '30 days' AND token_key_id<>'erased' ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE identity_challenges c SET token_digest=$1 || uuid_send(c.id),token_key_id='erased' FROM expired WHERE c.id=expired.id`,
    [randomBytes(16)],
  );
  await pool.query(
    `WITH expired AS (SELECT id FROM identity_mail_deliveries WHERE finished_at<clock_timestamp()-interval '30 days' AND (provider_request_id IS NOT NULL OR acceptance_id IS NOT NULL OR failure_code IS NOT NULL) ORDER BY finished_at,id LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE identity_mail_deliveries d SET provider_request_id=NULL,acceptance_id=NULL,failure_code=NULL FROM expired WHERE d.id=expired.id`,
  );
  await pool.query(
    `DELETE FROM identity_rate_limits WHERE ctid IN (SELECT ctid FROM identity_rate_limits WHERE expires_at<clock_timestamp() ORDER BY expires_at LIMIT 1000)`,
  );
}

async function claimDelivery(
  pool: Pool,
  id: string,
  keys: IdentityKeyring,
  mail: IdentityMailConfig,
): Promise<IdentityMailMessage | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reference = (
      await client.query<ChallengeRow>(
        `SELECT c.* FROM identity_challenges c JOIN identity_mail_deliveries d ON d.challenge_id=c.id WHERE d.id=$1 AND d.status='queued'`,
        [id],
      )
    ).rows[0];
    if (!reference) {
      await client.query('COMMIT');
      return null;
    }
    // Use the business lock order (user -> invitation/challenge -> delivery), never delivery -> user.
    let eligible = false;
    if (reference.user_id) {
      const owner = (
        await client.query<{
          status: string;
          contact_generation: string;
          reset_generation: string;
        }>(
          `SELECT u.status,a.contact_generation,a.reset_generation FROM users u LEFT JOIN identity_account_admissions a ON a.user_id=u.id WHERE u.id=$1 FOR SHARE OF u`,
          [reference.user_id],
        )
      ).rows[0];
      eligible =
        owner?.status === 'active' &&
        (reference.purpose === 'verify_contact'
          ? owner.contact_generation
          : owner.reset_generation) === reference.generation;
      if (eligible && reference.purpose === 'reset_password') {
        eligible = !!(
          await client.query(
            `SELECT id FROM identity_contacts WHERE user_id=$1 AND revision=$2 AND lookup_digest=$3`,
            [reference.user_id, reference.contact_revision, reference.lookup_digest],
          )
        ).rowCount;
      }
    } else if (reference.invitation_id) {
      const invitationRef = (
        await client.query<{ created_by: string }>(
          'SELECT created_by FROM identity_invitations WHERE id=$1',
          [reference.invitation_id],
        )
      ).rows[0];
      if (invitationRef) {
        const administrator = (
          await client.query(
            `SELECT u.id FROM users u JOIN identity_account_admissions a ON a.user_id=u.id JOIN installation_admin i ON i.user_id=u.id WHERE u.id=$1 AND u.status='active' FOR SHARE OF u`,
            [invitationRef.created_by],
          )
        ).rowCount;
        const invitation = (
          await client.query(
            `SELECT id FROM identity_invitations WHERE id=$1 AND state='pending' AND generation=$2 AND expires_at>clock_timestamp() FOR SHARE`,
            [reference.invitation_id, reference.generation],
          )
        ).rowCount;
        eligible = !!administrator && !!invitation;
      }
    }
    const challenge = (
      await client.query(
        `SELECT id FROM identity_challenges WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
        [reference.id],
      )
    ).rowCount;
    const delivery = (
      await client.query<DeliveryRow>(
        `SELECT * FROM identity_mail_deliveries WHERE id=$1 AND status='queued' FOR UPDATE SKIP LOCKED`,
        [id],
      )
    ).rows[0];
    if (!delivery) {
      await client.query('COMMIT');
      return null;
    }
    if (
      !eligible ||
      !challenge ||
      delivery.purpose !== reference.purpose ||
      delivery.generation !== reference.generation ||
      !delivery.payload_ciphertext
    ) {
      await client.query(
        `UPDATE identity_mail_deliveries SET status='suppressed',failure_code='challenge_ineligible',finished_at=clock_timestamp(),updated_at=clock_timestamp(),payload_ciphertext=NULL,payload_nonce=NULL,payload_tag=NULL,encryption_key_id=NULL,payload_erased_at=clock_timestamp() WHERE id=$1`,
        [id],
      );
      await client.query('COMMIT');
      return null;
    }
    const plaintext = openIdentity(
      keys,
      {
        ciphertext: delivery.payload_ciphertext,
        nonce: delivery.payload_nonce,
        tag: delivery.payload_tag,
        encryption_key_id: delivery.encryption_key_id,
      },
      `identity:delivery:${delivery.id}:${delivery.challenge_id}:${delivery.purpose}:${delivery.generation}`,
    );
    const payload: unknown = JSON.parse(plaintext);
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('to' in payload) ||
      !('token' in payload) ||
      typeof payload.to !== 'string' ||
      typeof payload.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(payload.token)
    )
      throw notReady('identity delivery payload unavailable');
    const to = normalizeContactEmail(payload.to).address;
    const link = `${mail.origin}${PATHS[delivery.purpose]}#token=${payload.token}`;
    const message: IdentityMailMessage = {
      deliveryId: delivery.id,
      to,
      subject: SUBJECTS[delivery.purpose],
      text: `${SUBJECTS[delivery.purpose]}\n\nOpen this link and explicitly confirm the action:\n${link}\n\nIf you did not request this, ignore this message.`,
    };
    await client.query(
      `UPDATE identity_mail_deliveries SET status='submitting',attempt_count=attempt_count+1,provider_request_id=id::text,updated_at=clock_timestamp() WHERE id=$1`,
      [id],
    );
    await client.query('COMMIT');
    return message;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* No external send on unknown claim commit. */
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function runIdentityMailTick(
  pool: Pool,
  options: IdentityMailOptions = {},
): Promise<void> {
  try {
    await cleanIdentityMail(pool);
    const pending = (
      await pool.query<{ id: string }>(
        `SELECT id FROM identity_mail_deliveries WHERE status='queued' ORDER BY created_at,id LIMIT 20`,
      )
    ).rows;
    if (!pending.length) return;
    const keys = options.keys ?? loadIdentityKeyring();
    const mail = requireIdentityMailReady(options);
    for (const item of pending) {
      const message = await claimDelivery(pool, item.id, keys, mail);
      if (!message) continue;
      let result: IdentityMailResult;
      let timer: NodeJS.Timeout | undefined;
      const controller = new AbortController();
      try {
        const timeout = new Promise<IdentityMailResult>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ status: 'unknown', failureCode: 'transport_unknown' });
          }, mail.timeoutMs ?? 10000);
        });
        result = await Promise.race([mail.send(message, controller.signal), timeout]);
      } catch {
        result = { status: 'unknown', failureCode: 'transport_unknown' };
      } finally {
        clearTimeout(timer);
      }
      const status =
        result?.status === 'submitted'
          ? 'submitted'
          : result?.status === 'failed'
            ? 'failed'
            : 'unknown';
      const acceptanceId =
        status === 'submitted' &&
        'acceptanceId' in result &&
        typeof result.acceptanceId === 'string' &&
        SAFE_PROVIDER_ID.test(result.acceptanceId)
          ? result.acceptanceId
          : null;
      const failureCode =
        status === 'failed'
          ? 'provider_rejected'
          : status === 'unknown'
            ? 'transport_unknown'
            : null;
      await pool.query(
        `UPDATE identity_mail_deliveries SET status=$2,acceptance_id=$3,failure_code=$4,submitted_at=CASE WHEN $2='submitted' THEN clock_timestamp() ELSE NULL END,finished_at=clock_timestamp(),updated_at=clock_timestamp(),payload_ciphertext=NULL,payload_nonce=NULL,payload_tag=NULL,encryption_key_id=NULL,payload_erased_at=clock_timestamp() WHERE id=$1 AND status='submitting'`,
        [message.deliveryId, status, acceptanceId, failureCode],
      );
    }
  } catch {
    throw notReady('identity mail dependency unavailable');
  }
}
