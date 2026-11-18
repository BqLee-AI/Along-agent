// Claim phase: lease claim + send enqueue. Scans due scheduled tasks and, in
// one transaction per tick: row lock -> state/version check -> upsert lease ->
// enqueue the kind=send outbox row (status dispatched = handed to delivery).
// Fencing: only the lease owner whose expected_state_version matches may
// fire. The send insert keys on send:<taskId>:<fireAtIso> with ON CONFLICT
// DO NOTHING, so repeated claims never duplicate the send row.
import { LEASE_TTL_MS, sendKeyFor } from '@along/scheduler-core';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../../db/transaction.js';
import { listClaimCandidates, upsertTaskLease } from './scheduler-repository.js';

export const CLAIM_BATCH_LIMIT = 50;

export interface ClaimSummary {
  scanned: number;
  claimed: number;
  enqueued: number;
}

export async function runClaimPhase(
  pool: Pool,
  workerId: string,
  now: Date = new Date(),
): Promise<ClaimSummary> {
  const summary: ClaimSummary = { scanned: 0, claimed: 0, enqueued: 0 };
  await withTransaction(pool, async (client: PoolClient) => {
    const candidates = await listClaimCandidates(client, workerId, CLAIM_BATCH_LIMIT);
    for (const task of candidates) {
      summary.scanned += 1;
      await upsertTaskLease(client, {
        taskId: task.id,
        ownerId: task.owner_id,
        expectedStateVersion: task.state_version,
        leaseOwner: workerId,
        expiresAt: new Date(now.getTime() + LEASE_TTL_MS),
      });
      summary.claimed += 1;
      const enqueued = await enqueueSendRow(client, task);
      if (enqueued) summary.enqueued += 1;
    }
  });
  return summary;
}

async function enqueueSendRow(
  client: PoolClient,
  task: {
    id: string;
    owner_id: string;
    state_version: number;
    fire_at_utc: Date;
    schedule_receipt: string | null;
  },
): Promise<boolean> {
  const key = sendKeyFor(task.id, task.fire_at_utc.toISOString());
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO outbox (id, owner_id, task_id, expected_state_version,
       command, idempotency_key, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'dispatched')
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      task.owner_id,
      task.id,
      task.state_version,
      JSON.stringify({
        kind: 'send',
        task_id: task.id,
        fire_at_utc: task.fire_at_utc.toISOString(),
        expected_state_version: task.state_version,
        schedule_receipt: task.schedule_receipt,
        idempotency_key: key,
      }),
      key,
    ],
  );
  return rows.length > 0;
}
