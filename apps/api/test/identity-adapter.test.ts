import { describe, expect, it } from 'vitest';
import { mapValue, translateWhere } from '../src/modules/identity/pg-adapter.js';

const SECRET = 'test-secret-for-identity-unit';

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
