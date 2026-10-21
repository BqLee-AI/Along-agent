import { Pool, type PoolClient, type PoolConfig } from 'pg';

// With no explicit options or DATABASE_URL, routes report NOT_READY.
export function createPool(connection?: string | PoolConfig): Pool | null {
  const options =
    typeof connection === 'string'
      ? { connectionString: connection }
      : (connection ?? { connectionString: process.env.DATABASE_URL });
  if (!connection && !options.connectionString) return null;
  const pool = new Pool({ max: 10, ...options });
  pool.on('error', reportConnectionError);
  pool.on('connect', observeConnection);
  return pool;
}

function observeConnection(client: PoolClient): void {
  // Checked-out clients emit errors independently of the pool's idle listener.
  client.on('error', reportConnectionError);
}

function reportConnectionError(error: Error): void {
  console.error('[db] connection lost:', error.message);
}

export type { Pool, PoolClient };
