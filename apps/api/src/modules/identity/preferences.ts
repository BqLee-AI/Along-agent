import type { PoolClient } from 'pg';
import { forbidden, HttpError } from '../../http/errors.js';
import type { TimeContext } from '../time/context.js';

// Public identity reads share the caller's transaction; no session or HTTP DTO
// is involved in reading already-trusted owner preferences.
export async function readUserPreferences(
  client: PoolClient,
  ownerId: string,
): Promise<{ timezone_id: string | null }> {
  const { rows } = await client.query<{ timezone_id: string | null }>(
    'SELECT timezone_id FROM users WHERE id = $1',
    [ownerId],
  );
  return { timezone_id: rows[0]?.timezone_id ?? null };
}

// Only this preference may be changed. The caller owns the transaction so its
// accepted receipt and audit cannot commit separately from the identity write.
export async function setUserTimezoneWithinTransaction(
  client: PoolClient,
  ownerId: string,
  timezoneId: string | null,
  timeContext: TimeContext,
): Promise<{
  timezone_id: string | null;
  previous_timezone_id: string | null;
  alias_version: string;
}> {
  let canonicalTimezone = timezoneId;
  if (timezoneId !== null) {
    if (!timeContext.available)
      throw new HttpError(503, 400006, 'TZDB_UNAVAILABLE', '时区规则库暂不可用，未保存偏好。');
    canonicalTimezone = Object.hasOwn(timeContext.aliases.aliases, timezoneId)
      ? timeContext.aliases.aliases[timezoneId]!
      : timezoneId;
    if (!Object.hasOwn(timeContext.ruleset.zones, canonicalTimezone))
      throw new HttpError(422, 422, 'UNKNOWN_TIMEZONE', '本版本不支持这个时区，未保存偏好。');
  }
  const { rows } = await client.query<{ timezone_id: string | null; status: string }>(
    'SELECT timezone_id,status FROM users WHERE id=$1 FOR UPDATE',
    [ownerId],
  );
  const previous = rows[0];
  if (!previous || previous.status !== 'active') throw forbidden('owner cannot update timezone');
  await client.query('UPDATE users SET timezone_id=$2,updated_at=clock_timestamp() WHERE id=$1', [
    ownerId,
    canonicalTimezone,
  ]);
  return {
    timezone_id: canonicalTimezone,
    previous_timezone_id: previous.timezone_id,
    alias_version: timeContext.available ? timeContext.aliases.version : 'unavailable',
  };
}

export interface OwnerEligibilityOptions {
  lock?: 'share';
}

export async function isActiveOwner(
  client: PoolClient,
  ownerId: string,
  options: OwnerEligibilityOptions = {},
): Promise<boolean> {
  const { rows } = await client.query<{ status: string; admitted: boolean }>(
    `SELECT u.status, EXISTS (
       SELECT 1 FROM identity_account_admissions a WHERE a.user_id=u.id
     ) AS admitted FROM users u WHERE u.id=$1${options.lock === 'share' ? ' FOR SHARE OF u' : ''}`,
    [ownerId],
  );
  return rows[0]?.status === 'active' && rows[0].admitted;
}
