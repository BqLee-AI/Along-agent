import { describe, expect, it } from 'bun:test';
import * as auth from '../src/auth.js';

const password = ' password ';
const token = 'a'.repeat(43);
const id = '11111111-1111-4111-8111-111111111111';
const now = '2026-11-03T00:00:00.000Z';
const delivery = { delivery_id: id, status: 'submitted', updated_at: now };

describe('invited-account strict DTO boundaries', () => {
  it('requires one explicit login branch and preserves password bytes and mailbox case', () => {
    expect(auth.authSignInSchema.parse({ email: 'Mixed@Example.COM', password })).toEqual({
      email: 'Mixed@Example.COM',
      password,
    });
    for (const body of [
      { password },
      { login_name: 'x', email: 'a@example.com', password },
      { email: 'a@example.com', password, callbackURL: '/' },
    ])
      expect(auth.authSignInSchema.safeParse(body).success).toBe(false);
    expect(auth.authSignInSchema.parse({ login_name: ' USER ', password })).toEqual({
      login_name: 'user',
      password,
    });
  });
  it('accepts syntax-only maximum email length and rejects larger or malformed syntax', () => {
    const address = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(address.length).toBe(254);
    expect(auth.authPasswordForgotSchema.parse({ email: address }).email).toBe(address);
    expect(auth.authPasswordForgotSchema.parse({ email: ` \t${address}\r\n` }).email).toBe(address);
    expect(auth.authSignInSchema.parse({ email: ' a!b@Example.COM ', password })).toEqual({
      email: 'a!b@Example.COM',
      password,
    });
    for (const email of [
      `a${address}`,
      'no-at',
      '\u00a0a@example.com',
      'a@example.com,b@example.com',
      'a@\nexample.com',
    ])
      expect(auth.authPasswordForgotSchema.safeParse({ email }).success).toBe(false);
  });
  it('rejects unknown target fields for every write and preserves every password byte', () => {
    const cases = [
      [auth.authContactRequestSchema, { email: 'a@example.com', current_password: password }],
      [auth.authContactVerifySchema, { token }],
      [
        auth.authInvitationCreateSchema,
        { email: 'a@example.com', current_password: password, idempotency_key: id },
      ],
      [auth.authInvitationResendSchema, { current_password: password, idempotency_key: id }],
      [auth.authInvitationRevokeSchema, { current_password: password }],
      [
        auth.authInvitationAcceptSchema,
        { token, login_name: 'user', password, display_name: 'User' },
      ],
      [auth.authPasswordForgotSchema, { email: 'a@example.com' }],
      [auth.authPasswordResetSchema, { token, new_password: password }],
      [auth.authPasswordChangeSchema, { current_password: password, new_password: password }],
      [auth.authSessionRevokeSchema, {}],
      [auth.authSessionsRevokeSchema, { scope: 'others', current_password: password }],
      [auth.authDisableUserSchema, { current_password: password, confirmed: true }],
      [auth.authDeletionRequestSchema, { current_password: password, confirmed: true }],
    ] as const;
    for (const [schema, body] of cases) {
      expect(schema.safeParse(body).success).toBe(true);
      for (const key of [
        'owner_id',
        'user_id',
        'callbackURL',
        'rememberMe',
        'password_confirmation',
      ])
        expect(schema.safeParse({ ...body, [key]: 'forbidden' }).success).toBe(false);
      const parsed = schema.parse(body) as Record<string, unknown>;
      for (const key of ['password', 'current_password', 'new_password'])
        if (key in body) expect(parsed[key]).toBe(password);
    }
  });
  it('enforces password UTF16 boundaries, true confirmation, UUID keys, finite scope and token syntax', () => {
    for (const value of ['a'.repeat(7), 'a'.repeat(129)])
      expect(
        auth.authPasswordChangeSchema.safeParse({ current_password: password, new_password: value })
          .success,
      ).toBe(false);
    expect(
      auth.authPasswordResetSchema.safeParse({ token, new_password: '😀'.repeat(4) }).success,
    ).toBe(true);
    for (const value of ['', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`])
      expect(auth.authContactVerifySchema.safeParse({ token: value }).success).toBe(false);
    expect(
      auth.authDisableUserSchema.safeParse({ current_password: password, confirmed: false })
        .success,
    ).toBe(false);
    expect(auth.authDeletionRequestSchema.safeParse({ current_password: password }).success).toBe(
      false,
    );
    expect(
      auth.authSessionsRevokeSchema.safeParse({ current_password: password, scope: 'current' })
        .success,
    ).toBe(false);
    expect(
      auth.authInvitationResendSchema.safeParse({
        current_password: password,
        idempotency_key: 'not-uuid',
      }).success,
    ).toBe(false);
  });
  it('defaults and bounds strict pagination without coercing booleans, arrays or null', () => {
    expect(auth.authListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(auth.authListQuerySchema.parse({ limit: '50', cursor: 'opaque' })).toEqual({
      limit: 50,
      cursor: 'opaque',
    });
    for (const limit of [0, 51, '1.5', '', true, null, ['1']])
      expect(auth.authListQuerySchema.safeParse({ limit }).success).toBe(false);
    for (const query of [
      { cursor: 'x'.repeat(2049) },
      { cursor: '' },
      { owner_id: id },
      { limit: '2', extra: true },
    ])
      expect(auth.authListQuerySchema.safeParse(query).success).toBe(false);
  });
  it('accepts only documented projections, never tokens, raw addresses or delivered claims', () => {
    expect(auth.DeliveryViewSchema.safeParse(delivery).success).toBe(true);
    expect(auth.DeliveryViewSchema.safeParse({ ...delivery, status: 'delivered' }).success).toBe(
      false,
    );
    const account = {
      user: { id, display_name: 'User' },
      account_status: 'active',
      installation_admin: false,
      contact: { state: 'unbound', masked_email: null, verified_at: null },
      pending_contact: { masked_email: 'a***@example.com', expires_at: now, delivery },
      workspace: { count: 0, state: 'none' },
    };
    expect(auth.AccountViewSchema.safeParse(account).success).toBe(true);
    expect(auth.AccountViewSchema.safeParse({ ...account, root: '/private' }).success).toBe(false);
    expect(
      auth.AccountViewSchema.safeParse({
        ...account,
        user: { ...account.user, auth_email: 'opaque' },
      }).success,
    ).toBe(false);
    const session = {
      id,
      created_at: now,
      expires_at: now,
      revoked_at: null,
      current: true,
      device_summary: 'Browser',
    };
    expect(auth.SessionViewSchema.safeParse(session).success).toBe(true);
    for (const device_summary of ['bad\nheader', 'x'.repeat(129)])
      expect(auth.SessionViewSchema.safeParse({ ...session, device_summary }).success).toBe(false);
    expect(auth.SessionViewSchema.safeParse({ ...session, token }).success).toBe(false);
    expect(
      auth.authInvitationAcceptedSchema.safeParse({ account_created: true, authenticated: true })
        .success,
    ).toBe(false);
    expect(
      auth.authPasswordForgottenSchema.safeParse({ accepted: true, delivery_id: id }).success,
    ).toBe(false);
    expect(
      auth.authPasswordResetResultSchema.safeParse({
        password_changed: true,
        authenticated: false,
        token,
      }).success,
    ).toBe(false);
  });
  it('keeps every response and nested list projection strict', () => {
    const invitation = {
      id,
      masked_email: 'a***@example.com',
      state: 'pending',
      generation: 1,
      created_at: now,
      expires_at: now,
      accepted_at: null,
      revoked_at: null,
      delivery,
    };
    const managed = {
      id,
      display_name: 'User',
      status: 'active',
      admitted: true,
      installation_admin: false,
      masked_email: 'a***@example.com',
      created_at: now,
    };
    const session = {
      id,
      created_at: now,
      expires_at: now,
      revoked_at: null,
      current: false,
      device_summary: null,
    };
    const cases = [
      [auth.InvitationViewSchema, invitation],
      [auth.ManagedAccountViewSchema, managed],
      [auth.authContactRequestedSchema, { contact_state: 'pending', delivery }],
      [auth.authContactVerifiedSchema, { contact_state: 'verified' }],
      [auth.authInvitationCreatedSchema, { invitation }],
      [auth.authInvitationRevokedSchema, { revoked: true }],
      [auth.authInvitationAcceptedSchema, { account_created: true, authenticated: false }],
      [auth.authPasswordForgottenSchema, { accepted: true }],
      [auth.authPasswordResetResultSchema, { password_changed: true, authenticated: false }],
      [auth.authPasswordChangedSchema, { password_changed: true, signed_out: true }],
      [auth.authSessionRevokedSchema, { revoked: true, signed_out: false }],
      [auth.authUserDisabledSchema, { disabled: true }],
      [auth.authDeletionRequestedSchema, { deletion_requested: true, signed_out: true }],
      [auth.authInvitationsSchema, { items: [invitation], next_cursor: null }],
      [auth.authSessionsSchema, { items: [session], next_cursor: 'opaque' }],
      [auth.authUsersSchema, { items: [managed], next_cursor: null }],
    ] as const;
    for (const [schema, data] of cases) {
      expect(schema.safeParse(data).success).toBe(true);
      expect(schema.safeParse({ ...data, owner_id: id }).success).toBe(false);
    }
    expect(
      auth.authInvitationsSchema.safeParse({ items: [{ ...invitation, token }], next_cursor: null })
        .success,
    ).toBe(false);
    expect(
      auth.authUsersSchema.safeParse({
        items: [{ ...managed, email: 'a@example.com' }],
        next_cursor: null,
      }).success,
    ).toBe(false);
    expect(auth.InvitationViewSchema.safeParse({ ...invitation, generation: 0 }).success).toBe(
      false,
    );
  });
});
