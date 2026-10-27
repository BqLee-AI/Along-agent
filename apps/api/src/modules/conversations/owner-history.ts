import type { Pool, PoolClient } from 'pg';

/** Public read-only installation history projection; no identity-table access. */
export async function listHistoricalOwners(db: Pool | PoolClient): Promise<string[]> {
  const { rows } = await db.query<{ owner_id: string }>(
    `SELECT owner_id FROM conversations WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM messages WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM agent_runs WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM run_attempts WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM run_checkpoints WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM agent_revisions WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM conversation_idempotency WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM tool_calls WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM harness_resumes WHERE owner_id IS NOT NULL UNION SELECT owner_id FROM harness_cancellations WHERE owner_id IS NOT NULL`,
  );
  return rows.map((row) => row.owner_id);
}
