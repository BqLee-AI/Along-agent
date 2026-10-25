import type { PoolClient } from 'pg';

// Public identity reads share the caller's transaction; no session or HTTP DTO
// is involved in reading already-trusted owner preferences.
export async function readUserPreferences(
  client: PoolClient,
  ownerId: string,
): Promise<{ timezone_id: string | null }> {
  const { rows } = await client.query<{ timezone_id: string | null }>(
    'SELECT timezone_id FROM users WHERE id = $1',
    [ownerId],
  );
  return { timezone_id: rows[0]?.timezone_id ?? null };
}

export async function isActiveOwner(client: PoolClient, ownerId: string): Promise<boolean> {
  const { rows } = await client.query<{ status: string }>(
    'SELECT status FROM users WHERE id = $1',
    [ownerId],
  );
  return rows[0]?.status === 'active';
}
