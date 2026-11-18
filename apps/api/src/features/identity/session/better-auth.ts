import { betterAuth, type Auth, type BetterAuthOptions } from 'better-auth';
import { createAdapterFactory, type AdapterFactory } from 'better-auth/adapters';
import type { Pool, PoolClient } from 'pg';
import { createPgAdapter } from './pg-adapter.js';

export interface AuthOptions {
  secret?: string;
  origin?: string;
  client?: PoolClient;
}
export function createAuth(pool: Pool | null, options: AuthOptions = {}) {
  const secret = options.secret ?? process.env.BETTER_AUTH_SECRET;
  if (!pool || !secret) return null;
  const origin = options.origin ?? process.env.APP_ORIGIN ?? 'http://localhost:3000';
  function factory(client?: PoolClient): AdapterFactory<BetterAuthOptions> {
    return createAdapterFactory({
      config: {
        adapterId: 'along-pg',
        adapterName: 'Along PG Adapter',
        usePlural: false,
        supportsBooleans: true,
        supportsDates: true,
        supportsJSON: true,
        supportsArrays: false,
        supportsUUIDs: true,
        transaction: async (callback) => {
          if (client) return callback(factory(client)(authOptions));
          const connection = await pool!.connect();
          try {
            await connection.query('BEGIN');
            const result = await callback(factory(connection)(authOptions));
            await connection.query('COMMIT');
            return result;
          } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
          } finally {
            connection.release();
          }
        },
      },
      adapter: () => createPgAdapter({ pool: client ?? pool!, secret }),
    });
  }
  const authOptions = {
    secret,
    baseURL: origin,
    trustedOrigins: [origin],
    advanced: { database: { generateId: 'uuid' as const } },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 604800,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      modelName: 'sessions',
      fields: {
        userId: 'user_id',
        token: 'token_hash',
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'last_seen_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
      },
      additionalFields: {
        revoked_at: { type: 'date' as const, required: false },
        client_info: { type: 'json' as const, required: false },
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
        auth_subject: { type: 'string' as const, required: false },
        auth_provider: { type: 'string' as const, required: false },
        primary_email_hash: { type: 'string' as const, required: false },
        timezone_id: { type: 'string' as const, required: false },
        status: { type: 'string' as const, required: false },
        metadata: { type: 'json' as const, required: false },
      },
    },
    account: {
      modelName: 'auth_accounts',
      fields: {
        userId: 'user_id',
        providerId: 'provider_id',
        accountId: 'account_id',
        password: 'password_hash',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
  };
  return betterAuth({ ...authOptions, database: factory(options.client) });
}
export type AuthInstance = Auth;
