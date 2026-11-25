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
import { mapValue, translateWhere } from '../src/features/identity/session/pg-adapter.js';

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

describe('pg-adapter where translation', () => {
  it('translates eq with offset placeholders', () => {
    const { sql, params } = translateWhere(
      'users',
      [{ field: 'auth_email', value: 'h@local.invalid' }],
      3,
    );
    expect(sql).toBe('"auth_email" = $3');
    expect(params).toEqual(['h@local.invalid']);
  });

  it('hashes session token lookups to token_hash', () => {
    process.env.BETTER_AUTH_SECRET = SECRET;
    try {
      const { sql, params } = translateWhere('sessions', [
        { field: 'token_hash', value: 'raw-token' },
      ]);
      expect(sql).toBe('"token_hash" = $1');
      expect(params).toHaveLength(1);
      expect(params[0]).not.toBe('raw-token');
      expect(mapValue('sessions', 'token', 'raw-token')).toEqual(
        mapValue('sessions', 'token_hash', 'raw-token'),
      );
    } finally {
      delete process.env.BETTER_AUTH_SECRET;
    }
  });

  it('supports null, in, and range operators with connectors', () => {
    const { sql, params } = translateWhere('sessions', [
      { field: 'revoked_at', value: null },
      { field: 'user_id', value: ['a', 'b'], operator: 'in', connector: 'AND' },
      { field: 'expires_at', value: '2026-01-01', operator: 'gt', connector: 'AND' },
    ]);
    expect(sql).toBe('"revoked_at" IS NULL AND "user_id" IN ($1,$2) AND "expires_at" > $3');
    expect(params).toEqual(['a', 'b', '2026-01-01']);
  });

  it('rejects unknown tables, columns, and operators', () => {
    expect(() => translateWhere('nope', [{ field: 'id', value: 'x' }])).toThrow('unknown table');
    expect(() => translateWhere('users', [{ field: 'nope', value: 'x' }])).toThrow(
      'unknown column',
    );
    expect(() => translateWhere('users', [{ field: 'id', value: 'x', operator: 'like' }])).toThrow(
      'unsupported operator',
    );
  });
});
