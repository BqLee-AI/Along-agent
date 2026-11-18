import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Identity crypto (issue #27): HMAC session tokens, CSRF derivation, opaque
// auth_email handles. Secrets never leave this module; only hashes persist.

function requireSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required');
  return secret;
}

// Session token presented to the client (cookie value). Stored as
// sha256 HMAC in sessions.token_hash; never persisted in plaintext.
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string, secret?: string): string {
  const key = secret ?? requireSecret();
  return createHmac('sha256', key).update(`session:${token}`, 'utf8').digest('hex');
}

// Opaque auth_email handle: HMAC-derived, never the plaintext identifier.
// Rotating BETTER_AUTH_SECRET invalidates derived logins (documented).
export function deriveAuthEmail(identifier: string, secret?: string): string {
  const key = secret ?? requireSecret();
  const normalized = identifier.trim().toLowerCase();
  const digest = createHmac('sha256', key).update(`email:${normalized}`, 'utf8').digest('hex');
  return `${digest}@local.invalid`;
}

export function deriveEmailHash(identifier: string, secret?: string): string | null {
  const normalized = identifier.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  const key = secret ?? requireSecret();
  return createHmac('sha256', key)
    .update(`email:${normalized.toLowerCase()}`, 'utf8')
    .digest('hex');
}

// CSRF token bound to the session id: HMAC(sessionId), verified
// timing-safe. Stateless: no extra column.
export function deriveCsrfToken(sessionId: string, secret?: string): string {
  const key = secret ?? requireSecret();
  return createHmac('sha256', key).update(`csrf:${sessionId}`, 'utf8').digest('hex');
}

export function verifyCsrfToken(sessionId: string, presented: string, secret?: string): boolean {
  const key = secret ?? requireSecret();
  const expected = Buffer.from(deriveCsrfToken(sessionId, key), 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// Signed session cookie value (issue #27): Better Auth signs the session
// cookie as `<token>.<base64 HMAC-SHA256(secret, token)>` (see better-call
// serializeSignedCookie/getSignedCookie). The seed CLI mints the same shape
// so the resolver and `auth.api.getSession` share one chain; the resolver
// verifies the signature before hashing the token for the DB lookup.
export function signSessionCookieValue(token: string, secret?: string): string {
  const key = secret ?? requireSecret();
  const signature = createHmac('sha256', key).update(token, 'utf8').digest('base64');
  return `${token}.${signature}`;
}

export function verifySignedCookieValue(signed: string, secret?: string): string | null {
  const key = secret ?? requireSecret();
  const dot = signed.lastIndexOf('.');
  if (dot < 1) return null;
  const token = signed.slice(0, dot);
  const signature = signed.slice(dot + 1);
  if (signature.length !== 44 || !signature.endsWith('=')) return null;
  const expected = Buffer.from(
    createHmac('sha256', key).update(token, 'utf8').digest('base64'),
    'utf8',
  );
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return null;
  return timingSafeEqual(expected, actual) ? token : null;
}
