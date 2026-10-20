import { describe, expect, it } from 'bun:test';
import { parseRole } from '../src/role.js';

describe('role', () => {
  it('defaults to all', () => {
    expect(parseRole(undefined)).toBe('all');
  });

  it('accepts api|worker|all', () => {
    expect(parseRole('api')).toBe('api');
    expect(parseRole('worker')).toBe('worker');
    expect(parseRole('all')).toBe('all');
  });

  it('fails fast on unknown role', () => {
    expect(() => parseRole('gateway')).toThrow();
  });
});
