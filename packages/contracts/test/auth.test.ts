import { describe, expect, it } from 'bun:test';
import {
  authInitializeSchema,
  authClaimSchema,
  authSignInSchema,
  authSignOutSchema,
  authStatusSchema,
} from '../src/index.js';

describe('R1 public account DTOs', () => {
  const input = {
    login_name: ' Mixed CASE ',
    password: ' leading and trailing ',
    display_name: ' Name ',
  };
  it('normalizes login/display names but never trims a password', () => {
    expect(authInitializeSchema.parse(input)).toEqual({
      login_name: 'mixed case',
      password: input.password,
      display_name: 'Name',
    });
    expect(
      authSignInSchema.parse({ login_name: input.login_name, password: input.password }).password,
    ).toBe(input.password);
  });
  it('uses JavaScript UTF16 length and validates both boundaries', () => {
    expect(authSignInSchema.safeParse({ login_name: 'x', password: '😀'.repeat(4) }).success).toBe(
      true,
    );
    expect(authSignInSchema.safeParse({ login_name: 'x', password: '😀'.repeat(65) }).success).toBe(
      false,
    );
    for (const password of ['x'.repeat(7), 'x'.repeat(129)])
      expect(authSignInSchema.safeParse({ login_name: 'x', password }).success).toBe(false);
    expect(
      authSignInSchema.safeParse({ login_name: 'x'.repeat(128), password: 'x'.repeat(128) })
        .success,
    ).toBe(true);
    for (const login_name of [' ', 'x'.repeat(129)])
      expect(authSignInSchema.safeParse({ login_name, password: input.password }).success).toBe(
        false,
      );
  });
  it('rejects every unapproved field, target-owner override and missing confirmation', () => {
    for (const key of ['user_id', 'owner_id', 'rememberMe', 'callbackURL', 'model'])
      expect(authInitializeSchema.safeParse({ ...input, [key]: 'not allowed' }).success).toBe(
        false,
      );
    expect(
      authClaimSchema.safeParse({ login_name: 'x', password: input.password, confirmed: true })
        .success,
    ).toBe(true);
    expect(
      authClaimSchema.safeParse({ login_name: 'x', password: input.password, confirmed: false })
        .success,
    ).toBe(false);
    expect(authSignOutSchema.safeParse({}).success).toBe(true);
    expect(authSignOutSchema.safeParse({ callbackURL: '/' }).success).toBe(false);
  });
  it('keeps anonymous status finite and accepts only documented signed-session additions', () => {
    expect(authStatusSchema.parse({ state: 'ready' })).toEqual({ state: 'ready' });
    expect(
      authStatusSchema.safeParse({ state: 'setup_required', owner_id: 'private' }).success,
    ).toBe(false);
    expect(
      authStatusSchema.safeParse({
        state: 'legacy_claim_required',
        can_claim: true,
        workspace_state: 'unconfigured',
      }).success,
    ).toBe(true);
  });
});
