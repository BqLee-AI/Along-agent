import type { Pool, PoolClient } from 'pg';

/** Public read-only installation history projection; no identity-table access. */
export async function listHistoricalOwners(db: Pool | PoolClient): Promise<string[]> {
  const { rows } = await db.query<{ owner_id: string }>(
    `SELECT owner_id FROM approvals WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM approval_revision_requests WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM document_approvals WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM document_approval_decisions WHERE owner_id IS NOT NULL`,
  );
  return rows.map((row) => row.owner_id);
}
