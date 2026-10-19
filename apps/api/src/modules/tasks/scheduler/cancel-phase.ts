// Cancel worker phase: drains outbox kind=cancel rows. For each row:
// lock row -> lock task -> if task already terminal, supersede; if the local
// registry holds a cancel receipt, finish cancel_pending -> cancelled +
// cancelled event (same txn); otherwise re-arm with backoff while attempts
// remain (provider revoke pending), else leave cancel_pending in place.
import { backoffMsForAttempt } from "@along/scheduler-core";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../../db/transaction.js";
import {
  appendTaskEvent,
  bumpOutboxAttempt,
  listDueCancelRows,
  lockOutboxRow,
  lockTaskRow,
  markOutboxDispatched,
  markOutboxFailedDeadline,
  markOutboxSuperseded,
  supersedeQueuedOutboxForTask,
  transitionTask,
  type OutboxRow,
} from "./scheduler-repository.js";
import { hasCancelReceipt } from "./registry.js";

export const CANCEL_BATCH_LIMIT = 50;

export interface CancelPhaseSummary {
  scanned: number;
  cancelled: number;
  pending: number;
  superseded: number;
}

function parseCancelCommand(row: OutboxRow): { taskId: string } | null {
  const command = row.command as Record<string, unknown> | null;
  if (!command || command.kind !== "cancel") return null;
  if (typeof command.task_id !== "string") return null;
  return { taskId: command.task_id };
}

async function cancelOne(
  client: PoolClient,
  row: OutboxRow,
  nowMs: number,
): Promise<keyof Omit<CancelPhaseSummary, "scanned">> {
  void nowMs;
  const parsed = parseCancelCommand(row);
  if (!parsed || parsed.taskId !== row.task_id) {
    await markOutboxSuperseded(client, row.id);
    return "superseded";
  }
  const task = await lockTaskRow(client, parsed.taskId);
  if (!task) {
    await markOutboxSuperseded(client, row.id);
    return "superseded";
  }
  if (task.state === "cancelled") {
    await markOutboxDispatched(client, row.id, `cancel:${task.id}`);
    return "superseded";
  }
  if (task.state === "fired" || task.state === "missed") {
    // Terminal the other way: the cancel command can never apply.
    await markOutboxSuperseded(client, row.id);
    return "superseded";
  }
  if (task.state !== "cancel_pending") return "pending";
  if (!hasCancelReceipt(task.id)) {
    // Revoke receipt not yet observed: re-arm while attempts remain so the
    // worker keeps polling; beyond that, leave the row pending (the task
    // stays cancel_pending, gate keeps blocking — never lie cancelled).
    const nextDelay = backoffMsForAttempt(row.attempt_no);
    if (nextDelay === null) return "pending";
    await bumpOutboxAttempt(client, {
      outboxId: row.id,
      attemptNo: row.attempt_no + 1,
      nextAttemptAt: new Date(Date.now() + nextDelay),
      lastError: "revoke receipt pending",
    });
    return "pending";
  }
  const moved = await transitionTask(client, {
    taskId: task.id,
    fromStates: ["cancel_pending"],
    toState: "cancelled",
    expectedVersion: task.state_version,
  });
  if (!moved) return "pending";
  await appendTaskEvent(client, {
    ownerId: task.owner_id,
    taskId: task.id,
    stateVersion: task.state_version + 1,
    type: "cancelled",
    evidenceRef: `cancel:${task.id}`,
  });
  await supersedeQueuedOutboxForTask(client, task.id);
  await markOutboxDispatched(client, row.id, `cancel:${task.id}`);
  void markOutboxFailedDeadline;
  return "cancelled";
}

export async function runCancelPhase(pool: Pool): Promise<CancelPhaseSummary> {
  const summary: CancelPhaseSummary = {
    scanned: 0,
    cancelled: 0,
    pending: 0,
    superseded: 0,
  };
  const client = await pool.connect();
  let rows: OutboxRow[];
  try {
    rows = await listDueCancelRows(client, CANCEL_BATCH_LIMIT);
  } finally {
    client.release();
  }
  for (const row of rows) {
    const disposition = await withTransaction(pool, async (txn: PoolClient) => {
      // Lock order (task before outbox). See runSendPhase.
      const probe = await txn.query<{ status: string }>(
        "SELECT status FROM outbox WHERE id = $1",
        [row.id],
      );
      if (!probe.rows[0] || probe.rows[0].status !== "pending") return null;
      await txn.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [row.task_id]);
      const locked = await lockOutboxRow(txn, row.id);
      if (!locked || locked.status !== "pending") return null;
      return cancelOne(txn, locked, Date.now());
    });
    if (!disposition) continue;
    summary.scanned += 1;
    if (disposition === "cancelled") summary.cancelled += 1;
    else if (disposition === "pending") summary.pending += 1;
    else if (disposition === "superseded") summary.superseded += 1;
  }
  return summary;
}
