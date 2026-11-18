import type { Pool, PoolClient } from 'pg';

/** Public read-only installation history projection; no identity-table access. */
export async function listHistoricalOwners(db: Pool | PoolClient): Promise<string[]> {
  const { rows } = await db.query<{ owner_id: string }>(
    `SELECT owner_id FROM notifications WHERE owner_id IS NOT NULL`,
  );
  return rows.map((row) => row.owner_id);
}
