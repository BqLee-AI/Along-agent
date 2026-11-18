import type { Pool, PoolClient } from 'pg';

/** Public read-only installation history projection; no identity-table access. */
export async function listHistoricalOwners(db: Pool | PoolClient): Promise<string[]> {
  const { rows } = await db.query<{ owner_id: string }>(
    `SELECT owner_id FROM tasks WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM task_events WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM outbox WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM task_leases WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM security_events WHERE owner_id IS NOT NULL`,
  );
  return rows.map((row) => row.owner_id);
}
