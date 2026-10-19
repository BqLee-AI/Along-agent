import { betterAuth, type Auth } from 'better-auth';
import { createAdapterFactory } from 'better-auth/adapters';
import type { Pool } from 'pg';
import { createPgAdapter } from './pg-adapter.js';
// - Field maps: email->auth_email (opaque HMAC handle), name->display_name,
//   token->token_hash (hashed at rest by pg-adapter), password->password_hash.
// - Session 7d fixed expiry; no refresh forwarding; no sign-up/sign-in HTTP
//   routes in v0 (server-side seed CLI only).
// - Returns null unless DATABASE_URL pool + BETTER_AUTH_SECRET exist, so
//   default compose/CI stays auth-off (D7 401 behavior unchanged).

function secretOf(): string | null {
  return process.env.BETTER_AUTH_SECRET ?? null;
}

export function createAuth(pool: Pool | null) {
  const secret = secretOf();
  if (!pool || !secret) return null;
  const pgAdapter = createPgAdapter({ pool });
  const factory = createAdapterFactory({
    config: {
      adapterId: 'along-pg',
      adapterName: 'Along PG Adapter',
      usePlural: false,
      supportsBooleans: true,
      supportsDates: true,
      supportsJSON: true,
      supportsArrays: false,
      supportsUUIDs: true,
    },
    adapter: () => pgAdapter,
  });
  return betterAuth({
    secret,
    baseURL: process.env.APP_ORIGIN ?? 'http://localhost:3000',
    trustedOrigins: process.env.APP_ORIGIN ? [process.env.APP_ORIGIN] : [],
    database: factory,
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      requireEmailVerification: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24 * 7,
      modelName: 'sessions',
      fields: {
        userId: 'user_id',
        token: 'token_hash',
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'last_seen_at',
      },
      additionalFields: {
        revoked_at: { type: 'date', required: false },
        client_info: { type: 'json', required: false },
      },
    },
    user: {
      modelName: 'users',
      fields: {
        email: 'auth_email',
        name: 'display_name',
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      additionalFields: {
        auth_subject: { type: 'string', required: false },
        auth_provider: { type: 'string', required: false },
        primary_email_hash: { type: 'string', required: false },
        timezone_id: { type: 'string', required: false },
        status: { type: 'string', required: false },
        metadata: { type: 'json', required: false },
      },
    },
    account: {
      modelName: 'auth_accounts',
      fields: {
        userId: 'user_id',
        providerId: 'provider_id',
        accountId: 'account_id',
      },
      additionalFields: {
        password_hash: { type: 'string', required: false },
      },
    },
  });
}

export type AuthInstance = Auth;
