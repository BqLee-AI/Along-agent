import { Pool, type PoolClient } from 'pg';

// Pool factory: created from DATABASE_URL on demand. Null pool (no
// DATABASE_URL) means "DB unavailable" — routes return 503 NOT_READY and
// integration tests skip instead of failing.
export function createPool(connectionString?: string): Pool | null {
  const dsn = connectionString ?? process.env.DATABASE_URL;
  if (!dsn) return null;
  return new Pool({ connectionString: dsn, max: 10 });
}

export type { Pool, PoolClient };
