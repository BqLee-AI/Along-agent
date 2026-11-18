import type { PoolClient } from 'pg';
import { notFound } from '../../../platform/errors.js';

/** Verify Run ownership using the caller's transaction, without loading or locking the Run. */
export async function assertOwnedRun(
  client: PoolClient,
  ownerId: string,
  runId: string,
): Promise<void> {
  const result = await client.query('SELECT 1 FROM agent_runs WHERE id=$1 AND owner_id=$2', [
    runId,
    ownerId,
  ]);
  if (!result.rowCount) throw notFound('run not found');
}
