import type { PoolClient } from 'pg';

/** Installation-local read projection; no account admission or session mutation. */
export async function readOwnerDisplayName(
  client: PoolClient,
  ownerId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ display_name: string }>(
    'SELECT display_name FROM users WHERE id=$1',
    [ownerId],
  );
  return rows[0]?.display_name ?? null;
}
