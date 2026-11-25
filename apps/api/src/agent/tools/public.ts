import type { Pool, PoolClient } from 'pg';

/** Read-only installation history projection. */
export async function listHistoricalOwners(db: Pool | PoolClient): Promise<string[]> {
  const { rows } = await db.query<{ owner_id: string }>(
    `SELECT owner_id FROM tool_invocations WHERE owner_id IS NOT NULL`,
  );
  return rows.map((row) => row.owner_id);
}
