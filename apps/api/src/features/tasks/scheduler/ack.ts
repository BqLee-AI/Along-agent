// Unknown delivery is reconciliation-only, including after the third check.
// A missing receipt never grants another call or proves delivery failure.
import { ACK_CHECK_DELAYS_MS, MAX_ACK_CHECKS, ackDelayForCheck } from '@along/scheduler-core';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../../db/transaction.js';
import { reconcileReceivedSend } from './delivery.js';
import {
  listDueAckRows,
  lockOutboxRow,
  lockTaskRow,
  markOutboxAckUnknown,
  markOutboxSuperseded,
  type OutboxRow,
} from './scheduler-repository.js';

export const ACK_BATCH_LIMIT = 50;

export interface AckSummary {
  scanned: number;
  confirmed: number;
  rearmed: number;
  superseded: number;
}

export async function runAckPhase(pool: Pool, nowMs?: number): Promise<AckSummary> {
  const summary: AckSummary = {
    scanned: 0,
    confirmed: 0,
    rearmed: 0,
    superseded: 0,
  };
  const client = await pool.connect();
  let rows: OutboxRow[];
  try {
    rows = await listDueAckRows(client, ACK_BATCH_LIMIT);
  } finally {
    client.release();
  }
  for (const candidate of rows) {
    const disposition = await withTransaction<keyof Omit<AckSummary, 'scanned'> | null>(
      pool,
      async (txn: PoolClient) => {
        // Preserve task -> outbox order. Ack never invokes the provider, so
        // its existing task lock strength need not change.
        const task = await lockTaskRow(txn, candidate.task_id);
        const row = await lockOutboxRow(txn, candidate.id);
        if (!row || row.task_id !== candidate.task_id || row.status !== 'acked_unknown') {
          return null;
        }
        if (!task) {
          await markOutboxSuperseded(txn, row.id);
          return 'superseded';
        }
        const reconciled = await reconcileReceivedSend(txn, task, row);
        if (reconciled === 'fired') return 'confirmed';
        if (reconciled === 'superseded') return 'superseded';

        const nextCheckNo = Math.min(row.ack_check_no + 1, MAX_ACK_CHECKS);
        const nextDelay = ackDelayForCheck(nextCheckNo) ?? ACK_CHECK_DELAYS_MS[2];
        await markOutboxAckUnknown(txn, {
          outboxId: row.id,
          ackCheckNo: nextCheckNo,
          nextCheckAt: new Date((nowMs ?? Date.now()) + nextDelay),
          lastError: row.last_error ?? 'inapp delivery outcome unknown; reconciliation only',
        });
        return 'rearmed';
      },
    );
    if (!disposition) continue;
    summary.scanned += 1;
    summary[disposition] += 1;
  }
  return summary;
}
