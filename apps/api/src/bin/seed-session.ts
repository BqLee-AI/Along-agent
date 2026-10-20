import { createPool } from '../db/pool.js';
import { seedSession } from '../modules/identity/seed.js';

// CLI: bun run --filter @along/api seed:session
// Requires DATABASE_URL + BETTER_AUTH_SECRET. Prints the session cookie
// value and CSRF token for local dev. Never log the secret itself.
async function main(): Promise<void> {
  const pool = createPool();
  if (!pool) {
    console.error('seed:session: DATABASE_URL is required');
    process.exit(1);
  }
  try {
    const displayName = process.argv[2] || undefined;
    const seeded = await seedSession(pool, displayName ? { displayName } : {});
    console.log(`user=${seeded.userId}`);
    console.log(`cookie: better-auth.session_token=${seeded.token}`);
    console.log(`csrf: ${seeded.csrfToken}`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

void main().catch((err: unknown) => {
  console.error(`seed:session failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
