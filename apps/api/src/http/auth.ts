import type { IncomingMessage } from 'node:http';
import type { Pool } from 'pg';
import {
  deriveCsrfToken,
  hashSessionToken,
  verifyCsrfToken,
  verifySignedCookieValue,
} from '../modules/identity/crypto.js';
import { notReady } from './errors.js';

// Actor resolution for HTTP routes (issue #27). Production posture is
// deny-by-default: the resolver returns null (-> 401 UNAUTHENTICATED) unless
// a valid session cookie is present. The local dev bridge (ALLOW_DEV_AUTH=1
// + DEV_OWNER_ID) exists only so routes can be exercised before Better Auth
// credentials exist; it MUST NOT trust any client-supplied owner header.

export interface Actor {
  ownerId: string;
  sessionId: string | null;
  displayName: string;
  timezoneId: string | null;
}

export interface ActorResolutionContext {
  allowLegacyClaim?: boolean;
}

export type ActorResolver = (
  req: IncomingMessage,
  context?: ActorResolutionContext,
) => Promise<Actor | null>;

export interface ResolverDeps {
  pool: Pool | null;
}

const SESSION_COOKIES = ['better-auth.session_token', '__Secure-better-auth.session_token'];

function cookieOf(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      // Malformed percent-escapes (URIError) mean unauthenticated, not 500.
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function sessionTokenOf(req: IncomingMessage): string | null {
  for (const name of SESSION_COOKIES) {
    const value = cookieOf(req, name);
    if (value) return value;
  }
  return null;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  display_name: string;
  timezone_id: string | null;
}

async function resolveSession(
  pool: Pool,
  signed: string,
  allowLegacyClaim: boolean,
): Promise<SessionRow | null> {
  let tokenHash: string;
  try {
    // Cookie carries `<token>.<signature>` (Better Auth signed-cookie
    // shape); verify before hashing. Unsigned/tampered values -> null.
    const token = verifySignedCookieValue(signed);
    if (!token) return null;
    tokenHash = hashSessionToken(token);
  } catch {
    return null;
  }
  const { rows } = await pool.query<SessionRow>(
    `SELECT s.id AS session_id, u.id AS user_id, u.display_name, u.timezone_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
        AND s.revoked_at IS NULL
        AND u.status = 'active'
        AND (EXISTS (SELECT 1 FROM identity_account_admissions a WHERE a.user_id=u.id)
          OR ($2::boolean
            AND NOT EXISTS (SELECT 1 FROM installation_admin)
            AND (SELECT count(*) FROM auth_accounts a WHERE a.user_id=u.id) <= 1
            AND NOT EXISTS (SELECT 1 FROM auth_accounts a WHERE a.user_id=u.id
              AND (a.password_hash IS NOT NULL OR a.account_id NOT IN (u.id::text,'seed:' || u.id::text)))))
      LIMIT 1`,
    [tokenHash, allowLegacyClaim],
  );
  return rows[0] ?? null;
}

export function createActorResolver(deps: ResolverDeps = { pool: null }): ActorResolver {
  const allowDevAuth = process.env.ALLOW_DEV_AUTH === '1';
  const devOwnerId = process.env.DEV_OWNER_ID;
  return async (req: IncomingMessage, context?: ActorResolutionContext) => {
    if (allowDevAuth && devOwnerId) {
      if (!deps.pool) throw notReady('session dependency unavailable');
      // Local dev bridge: still read the seeded user's display name/timezone so
      // brief/agent routes exercise the same timezone semantics as production.
      let displayName = '';
      let timezoneId: string | null = null;
      if (deps.pool) {
        const { rows } = await deps.pool.query<{
          display_name: string;
          timezone_id: string | null;
        }>(
          `SELECT display_name, timezone_id FROM users u WHERE id=$1 AND status='active'
            AND EXISTS (SELECT 1 FROM identity_account_admissions a WHERE a.user_id=u.id)`,
          [devOwnerId],
        );
        if (!rows[0]) return null;
        displayName = rows[0]?.display_name ?? '';
        timezoneId = rows[0]?.timezone_id ?? null;
      }
      return { ownerId: devOwnerId, sessionId: null, displayName, timezoneId };
    }
    const pool = deps.pool;
    const token = sessionTokenOf(req);
    if (!token) return null;
    if (!pool || !process.env.BETTER_AUTH_SECRET) throw notReady('session dependency unavailable');
    let row: SessionRow | null;
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const allowLegacyClaim =
        context?.allowLegacyClaim === true &&
        (pathname === '/api/v1/auth/status' || pathname === '/api/v1/auth/claim');
      row = await resolveSession(pool, token, allowLegacyClaim);
    } catch {
      throw notReady('session dependency unavailable');
    }
    if (!row) return null;
    return {
      ownerId: row.user_id,
      sessionId: row.session_id,
      displayName: row.display_name,
      timezoneId: row.timezone_id,
    };
  };
}

// Central CSRF guard (docs/api/auth/auth_routes.md §3): GET and probes skip;
// state-changing methods require the X-CSRF-Token header bound to the
// session id. Dev-bridge actors carry no session, so the guard passes them
// (local-only path; production always has a session).
export function verifyCsrf(req: IncomingMessage, actor: Actor): boolean {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  if (!actor.sessionId) return true;
  const presented = req.headers['x-csrf-token'];
  const token = Array.isArray(presented) ? presented[0] : presented;
  if (!token) return false;
  try {
    return verifyCsrfToken(actor.sessionId, token);
  } catch {
    return false;
  }
}

// Issue a CSRF token for an authenticated actor (GET /me response).
export function csrfTokenFor(actor: Actor): string | null {
  if (!actor.sessionId) return null;
  return deriveCsrfToken(actor.sessionId);
}
