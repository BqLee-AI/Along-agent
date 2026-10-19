// Missed phase:超 15min 标 missed (past 15 minutes -> missed). Scans tasks
// whose fire instant is fully outside the window and still await a terminal
// event: transition scheduled -> missed (+ missed event, copy carries the
// rebook hint), never refire. Cancels both the queued outbox (superseded).
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../../db/transaction.js";
import {
  appendTaskEvent,
  listMissedCandidates,
  lockOutboxRow,
  lockTaskRow,
  markOutboxFailedDeadline,
  supersedeQueuedOutboxForTask,
  transitionTask,
  type OutboxRow,
} from "./scheduler-repository.js";

export const MISSED_BATCH_LIMIT = 50;

export interface MissedSummary {
  scanned: number;
  missed: number;
}

async function missedOne(client: PoolClient, taskId: string): Promise<boolean> {
  const task = await lockTaskRow(client, taskId);
  if (!task) return false;
  if (task.state !== "scheduled") return false;
  const moved = await transitionTask(client, {
    taskId: task.id,
    fromStates: ["scheduled"],
    toState: "missed",
    expectedVersion: task.state_version,
  });
  if (!moved) return false;
  await appendTaskEvent(client, {
    ownerId: task.owner_id,
    taskId: task.id,
    stateVersion: task.state_version + 1,
    type: "missed",
    evidenceRef: "local",
  });
  await supersedeQueuedOutboxForTask(client, task.id);
  return true;
}

export async function runMissedPhase(pool: Pool): Promise<MissedSummary> {
  const summary: MissedSummary = { scanned: 0, missed: 0 };
  const candidates = await collectMissed(pool);
  for (const task of candidates) {
    const done = await withTransaction(pool, async (client: PoolClient) => {
      const locked = await lockTaskRow(client, task.id);
      if (!locked || locked.state !== "scheduled") return false;
      return missedOne(client, locked.id);
    });
    summary.scanned += 1;
    if (done) summary.missed += 1;
  }
  return summary;
}

async function collectMissed(
  pool: Pool,
): Promise<Array<{ id: string }>> {
  const client = await pool.connect();
  try {
    return await listMissedCandidates(client, MISSED_BATCH_LIMIT);
  } finally {
    client.release();
  }
}

export async function failSendRowPastDeadline(
  client: PoolClient,
  row: OutboxRow,
): Promise<void> {
  const task = await lockTaskRow(client, row.task_id);
  void task;
  await markOutboxFailedDeadline(client, row.id, "past fire window; needs rebook");
}

export { lockOutboxRow };
