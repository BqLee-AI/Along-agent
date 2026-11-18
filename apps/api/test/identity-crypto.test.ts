import { describe, expect, it } from 'bun:test';
import {
  deriveAuthEmail,
  deriveCsrfToken,
  deriveEmailHash,
  hashSessionToken,
  signSessionCookieValue,
  verifyCsrfToken,
  verifySignedCookieValue,
} from '../src/features/identity/session/crypto.js';

const SECRET = 'test-secret-for-identity-unit';

describe('identity crypto', () => {
  it('hashes session tokens deterministically and opaquely', () => {
    const a = hashSessionToken('token-1', SECRET);
    expect(a).toBe(hashSessionToken('token-1', SECRET));
    expect(a).not.toContain('token-1');
    expect(a).toHaveLength(64);
    expect(hashSessionToken('token-2', SECRET)).not.toBe(a);
  });

  it('derives opaque auth_email handles, normalized lowercase', () => {
    const a = deriveAuthEmail('Seed@Example.COM', SECRET);
    expect(a).toBe(deriveAuthEmail('seed@example.com', SECRET));
    expect(a.endsWith('@local.invalid')).toBe(true);
    expect(a).not.toContain('seed');
  });

  it('rejects non-email identifiers for the email hash', () => {
    expect(deriveEmailHash('not-an-email', SECRET)).toBeNull();
    expect(deriveEmailHash('a@b.co', SECRET)).toHaveLength(64);
  });

  it('verifies CSRF tokens timing-safe, rejects wrong ones', () => {
    const good = deriveCsrfToken('session-id', SECRET);
    expect(verifyCsrfToken('session-id', good, SECRET)).toBe(true);
    expect(verifyCsrfToken('session-id', 'wrong', SECRET)).toBe(false);
    expect(verifyCsrfToken('other-session', good, SECRET)).toBe(false);
  });

  it('round-trips signed cookie values, rejects tampered ones', () => {
    const signed = signSessionCookieValue('raw-token', SECRET);
    expect(verifySignedCookieValue(signed, SECRET)).toBe('raw-token');
    expect(verifySignedCookieValue('raw-token', SECRET)).toBeNull();
    expect(verifySignedCookieValue(`${signed}x`, SECRET)).toBeNull();
    expect(
      verifySignedCookieValue(signSessionCookieValue('raw-token', 'other-secret'), SECRET),
    ).toBeNull();
  });
});
