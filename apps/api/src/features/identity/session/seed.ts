import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  deriveAuthEmail,
  deriveCsrfToken,
  hashSessionToken,
  newSessionToken,
  signSessionCookieValue,
} from './crypto.js';

// Server-side session seeder (issue #27): v0 exposes no sign-up/sign-in
// HTTP endpoints, so local dev/integration tests mint sessions directly.
// `token` is the signed cookie value (`<token>.<signature>`, same shape as
// Better Auth's setSignedCookie); the plaintext token never persists
// (only its HMAC in sessions.token_hash).

export interface SeedSessionOptions {
  displayName?: string;
  timezoneId?: string;
  daysValid?: number;
}

export interface SeededSession {
  userId: string;
  token: string;
  csrfToken: string;
  sessionId: string;
}

export async function seedSession(
  pool: Pool,
  opts: SeedSessionOptions = {},
): Promise<SeededSession> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(680068, 1)');
    const bound = await client.query('SELECT 1 FROM installation_admin WHERE singleton=true');
    if (bound.rowCount)
      throw new Error('seed-session: administrator bound; use formal account sign-in');
    const token = newSessionToken();
    const identifier = `seed:${randomUUID()}`;
    const authEmail = deriveAuthEmail(identifier);
    const { rows: users } = await client.query<{ id: string }>(
      `INSERT INTO users (display_name, auth_email, timezone_id)
     VALUES ($1, $2, $3) RETURNING id`,
      [opts.displayName ?? 'Seed User', authEmail, opts.timezoneId ?? 'Asia/Shanghai'],
    );
    const userId = users[0]?.id;
    if (!userId) throw new Error('seed-session: user insert returned no id');
    await client.query(
      `INSERT INTO auth_accounts (user_id, provider_id, account_id)
     VALUES ($1, 'credential', $2)`,
      [userId, `seed:${userId}`],
    );
    // daysValid must stay positive: sessions_expiry_check (expires_at >
    // created_at) rejects expired inserts and backdating updates alike.
    // Expired fixtures backdate created+expires together in the test itself.
    const days = opts.daysValid ?? 7;
    const { rows: sessions } = await client.query<{ id: string }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at, client_info)
     VALUES ($1, $2, now() + ($3 || ' days')::interval, '{"seed":true}')
     RETURNING id`,
      [userId, hashSessionToken(token), String(days)],
    );
    const sessionId = sessions[0]?.id;
    if (!sessionId) throw new Error('seed-session: session insert returned no id');
    await client.query('COMMIT');
    return {
      userId,
      token: signSessionCookieValue(token),
      csrfToken: deriveCsrfToken(sessionId),
      sessionId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
