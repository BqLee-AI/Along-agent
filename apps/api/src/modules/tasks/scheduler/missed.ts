// A past-window task first reconciles its independent receipt under the same
// task lock. Only an unreceived, still-scheduled task may become missed.
import { isPastFireWindow, sendKeyFor } from '@along/scheduler-core';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../../db/transaction.js';
import { reconcileReceivedSend } from './delivery.js';
import {
  appendTaskEvent,
  listMissedCandidates,
  lockTaskRow,
  lockTaskSendRow,
  markOutboxFailedDeadline,
  supersedeQueuedOutboxForTask,
  transitionTask,
} from './scheduler-repository.js';

export const MISSED_BATCH_LIMIT = 50;

export interface MissedSummary {
  scanned: number;
  missed: number;
}

export async function runMissedPhase(pool: Pool, nowMs?: number): Promise<MissedSummary> {
  const summary: MissedSummary = { scanned: 0, missed: 0 };
  const candidates = await collectMissed(pool);
  for (const candidate of candidates) {
    const done = await withTransaction(pool, async (client: PoolClient) => {
      const task = await lockTaskRow(client, candidate.id);
      if (
        !task ||
        task.state !== 'scheduled' ||
        !isPastFireWindow(task.fire_at_utc.getTime(), nowMs ?? Date.now())
      ) {
        return false;
      }
      const row = await lockTaskSendRow(
        client,
        task.id,
        sendKeyFor(task.id, task.fire_at_utc.toISOString()),
      );
      const reconciled = row ? await reconcileReceivedSend(client, task, row) : null;
      if (reconciled === 'fired') return false;

      const moved = await transitionTask(client, {
        taskId: task.id,
        fromStates: ['scheduled'],
        toState: 'missed',
        expectedVersion: task.state_version,
      });
      if (!moved) throw new Error('missed fence changed while task lock held');
      await appendTaskEvent(client, {
        ownerId: task.owner_id,
        taskId: task.id,
        stateVersion: task.state_version + 1,
        type: 'missed',
        evidenceRef: 'local',
      });
      if (row && reconciled === 'notReceived') {
        await markOutboxFailedDeadline(
          client,
          row.id,
          `${row.last_error ?? 'no matching inapp receipt'}; past fire window; delivery outcome uncertain; needs rebook`,
        );
      }
      // Fail the current valid send before superseding the remaining queue,
      // so the uncertain outcome is retained rather than overwritten.
      await supersedeQueuedOutboxForTask(client, task.id);
      return true;
    });
    summary.scanned += 1;
    if (done) summary.missed += 1;
  }
  return summary;
}

async function collectMissed(pool: Pool): Promise<Array<{ id: string }>> {
  const client = await pool.connect();
  try {
    return await listMissedCandidates(client, MISSED_BATCH_LIMIT);
  } finally {
    client.release();
  }
}
