import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { HttpError, notReady } from '../../http/errors.js';
import type { IdentityKeyring } from './email-security.js';

export type IdentityQuotaAction =
  | 'sign_in'
  | 'forgot'
  | 'accept'
  | 'reset'
  | 'contact_request'
  | 'contact_verify'
  | 'invite_create'
  | 'invite_resend'
  | 'password_write';
export interface IdentityQuotaSubjects {
  ip: string;
  identifier?: string;
  address?: string;
  actor?: string;
  token?: string;
}
type Dimension = 'identifier' | 'address' | 'ip' | 'actor' | 'token';
interface Quota {
  action: IdentityQuotaAction;
  dimension: Dimension;
  limit: number;
  seconds: number;
  digest: Buffer;
}
export async function consumeIdentityQuota(
  pool: Pool,
  keys: IdentityKeyring,
  action: IdentityQuotaAction,
  subjects: IdentityQuotaSubjects,
): Promise<void> {
  const quotas: Quota[] = [];
  function add(dimension: Dimension, limit: number, seconds: number, scope = action): void {
    const input = subjects[dimension];
    if (
      typeof input !== 'string' ||
      ((dimension === 'ip' || dimension === 'actor') && input.length === 0)
    )
      throw notReady('identity quota context unavailable');
    // Invalid tokens still consume quota, without allocating unbounded input copies.
    const value =
      dimension === 'identifier' || dimension === 'address'
        ? input.slice(0, 4096).trim().toLowerCase()
        : input.slice(0, 4096);
    quotas.push({
      action: scope,
      dimension,
      limit,
      seconds,
      digest: createHmac('sha256', keys.rateLimit.key)
        .update(`identity:quota:v1:${dimension}:`)
        .update(value)
        .digest(),
    });
  }
  switch (action) {
    case 'sign_in':
      add('identifier', 10, 900);
      add('ip', 60, 900);
      break;
    case 'forgot':
      add('address', 3, 3600);
      add('ip', 20, 3600);
      break;
    case 'accept':
    case 'reset':
      add('token', 10, 900);
      add('ip', 60, 900);
      break;
    case 'contact_request':
      add('actor', 5, 3600);
      add('ip', 30, 3600);
      add('address', 3, 3600);
      break;
    case 'contact_verify':
      add('actor', 5, 3600, 'contact_request');
      add('ip', 30, 3600, 'contact_request');
      add('token', 10, 900);
      break;
    case 'invite_create':
    case 'invite_resend':
      add('actor', 20, 3600, 'invite_create');
      add('ip', 60, 3600, 'invite_create');
      // A missing/closed resend target still charges actor/IP, but has no
      // recipient to charge. Creation always requires its address dimension.
      if (action === 'invite_create' || subjects.address !== undefined)
        add('address', 3, 3600, 'invite_create');
      break;
    case 'password_write':
      add('actor', 10, 900);
      add('ip', 60, 900);
      break;
    default:
      throw notReady('identity quota action unavailable');
  }
  // Every action locks its IP first; the remaining shared dimensions retain a
  // consistent order across actions (notably contact and invite operations).
  quotas.sort(
    (a, b) =>
      Number(b.dimension === 'ip') - Number(a.dimension === 'ip') ||
      `${a.action}:${a.dimension}`.localeCompare(`${b.action}:${b.dimension}`),
  );
  const client = await pool.connect().catch(() => {
    throw notReady('identity quota unavailable');
  });
  let retryAfter = 0;
  try {
    await client.query('BEGIN');
    const { rows: times } = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const now = times[0]!.now.getTime();
    for (const quota of quotas) {
      const start = Math.floor(now / (quota.seconds * 1000)) * quota.seconds * 1000;
      const { rows } = await client.query<{ count: number }>(
        `INSERT INTO identity_rate_limits(action,dimension,subject_digest,subject_key_id,window_started_at,window_seconds,count,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,1,$7)
         ON CONFLICT(action,dimension,subject_digest,window_started_at,window_seconds)
         DO UPDATE SET count=LEAST(identity_rate_limits.count+1,$8)
         RETURNING count`,
        [
          quota.action,
          quota.dimension,
          quota.digest,
          keys.rateLimit.id,
          new Date(start),
          quota.seconds,
          new Date(start + quota.seconds * 1000 + 86400000),
          quota.limit + 1,
        ],
      );
      if (rows[0]!.count > quota.limit) {
        retryAfter = Math.max(
          retryAfter,
          Math.max(1, Math.ceil((start + quota.seconds * 1000 - now) / 1000)),
        );
        // Commit the rejected IP charge, but do not create attacker-chosen
        // subject rows once this source has exhausted its quota.
        if (quota.dimension === 'ip') break;
      }
    }
    await client.query('COMMIT');
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Unknown commit is a dependency failure, never a permit. */
    }
    throw notReady('identity quota unavailable');
  } finally {
    client.release();
  }
  if (retryAfter)
    throw new HttpError(429, 429, 'RATE_LIMITED', 'identity rate limit exceeded', {
      retry_after_seconds: retryAfter,
    });
}
