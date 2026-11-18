import { httpStatusForError } from '@along/contracts';
import { Pool } from 'pg';
import { parseIdentityKeyring } from '../../src/features/identity/security/email-security.js';
import { consumeIdentityQuota } from '../../src/features/identity/security/rate-limit.js';
import { ApplicationError } from '../../src/platform/errors.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  const keys = parseIdentityKeyring(JSON.parse(process.env.ISOLATED_IDENTITY_TEST_KEYS!));
  const results = await Promise.all(
    Array.from({ length: Number(process.argv[2] ?? 1) }, async () => {
      try {
        await consumeIdentityQuota(pool, keys, 'sign_in', {
          ip: '127.0.0.42',
          identifier: 'same-account',
        });
        return 200;
      } catch (error) {
        return error instanceof ApplicationError ? httpStatusForError(error.code) : 500;
      }
    }),
  );
  process.stdout.write(JSON.stringify(results));
} finally {
  await pool.end();
}
