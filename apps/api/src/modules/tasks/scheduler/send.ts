// Send phase:门禁 + Notifier.send. Runs under one transaction per outbox row:
// lock send row -> lock task -> gate three checks -> Notifier.send (local,
// in-app) -> notifications INSERT ... ON CONFLICT DO NOTHING -> task fired +
// fired event, or retry/ack_unknown/failed_deadline bookkeeping.
//
// Breach guard (design/07 §3): when the gate finds the task cancel-committed
// (cancel_pending/cancelled) the row is superseded; if it already fired, the
// send is a no-op — but a cancel submitted before this send committed and a
// fired send afterwards records one cancel_breach row for human review.
import {
  ackDelayForCheck,
  backoffMsForAttempt,
  isPastFireWindow,
  sendKeyFor,
} from "@along/scheduler-core";
import { outcomeOf } from "@along/notifier-core";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../../db/transaction.js";
import {
  appendTaskEvent,
  bumpOutboxAttempt,
  listDueSendRows,
  lockOutboxRow,
  lockTaskRow,
  markOutboxAckUnknown,
  markOutboxDispatched,
  markOutboxFailedDeadline,
  markOutboxSuperseded,
  recordCancelBreach,
  supersedeQueuedOutboxForTask,
  transitionTask,
  type OutboxRow,
} from "./scheduler-repository.js";
import { decideSendGate } from "./gate.js";
import {
  deliverInApp,
  type InAppDelivery,
  type InAppProvider,
} from "../../notifications/service.js";

export const SEND_BATCH_LIMIT = 50;

export interface SendSummary {
  scanned: number;
  fired: number;
  retried: number;
  ackUnknown: number;
  superseded: number;
  failedDeadline: number;
  breaches: number;
}

interface ParsedSendCommand {
  taskId: string;
  fireAtIso: string;
  expectedStateVersion: number;
  scheduleReceipt: string;
}

function parseSendCommand(row: OutboxRow): ParsedSendCommand | null {
  const command = row.command as Record<string, unknown> | null;
  if (!command || command.kind !== "send") return null;
  if (typeof command.task_id !== "string") return null;
  if (typeof command.fire_at_utc !== "string") return null;
  if (typeof command.schedule_receipt !== "string") return null;
  const expected =
    typeof command.expected_state_version === "number"
      ? command.expected_state_version
      : row.expected_state_version;
  return {
    taskId: command.task_id,
    fireAtIso: command.fire_at_utc,
    expectedStateVersion: expected,
    scheduleReceipt: command.schedule_receipt,
  };
}

async function sendOne(
  client: PoolClient,
  row: OutboxRow,
  provider: InAppProvider,
  nowMs: number,
): Promise<keyof Omit<SendSummary, "scanned">> {
  const parsed = parseSendCommand(row);
  if (!parsed || parsed.taskId !== row.task_id) {
    await markOutboxSuperseded(client, row.id);
    return "superseded";
  }
  const task = await lockTaskRow(client, parsed.taskId);
  if (!task) {
    await markOutboxSuperseded(client, row.id);
    return "superseded";
  }
  // Past the window at send time: terminal, never retry.
  if (isPastFireWindow(task.fire_at_utc.getTime(), nowMs)) {
    await markOutboxFailedDeadline(client, row.id, "past fire window at send time");
    return "failedDeadline";
  }
  const gate = decideSendGate({
    task,
    expectedStateVersion: parsed.expectedStateVersion,
    scheduleReceipt: parsed.scheduleReceipt,
    nowMs,
  });
  if (!gate.allowed) {
    if (gate.reason === "CANCEL_PENDING" || gate.reason === "CANCELLED") {
      await markOutboxSuperseded(client, row.id);
      return "superseded";
    }
    if (gate.reason === "MISSED") {
      await markOutboxFailedDeadline(client, row.id, "past fire window at gate");
      return "failedDeadline";
    }
    await markOutboxSuperseded(client, row.id);
    return "superseded";
  }

  const delivery: InAppDelivery = await deliverInApp(
    client,
    {
      ownerId: task.owner_id,
      taskId: task.id,
      wallTime: task.wall_time,
      timezoneId: task.timezone_id,
      originalNote: task.original_note,
      idempotencyKey: sendKeyFor(task.id, task.fire_at_utc.toISOString()),
    },
    provider,
  );
  const outcome = outcomeOf({ delivered: delivery.delivered, answered: delivery.answered });

  if (outcome === "sent") {
    // Cancel race: re-read the task state inside this transaction. A cancel
    // committed after our gate but before this commit turned the task away
    // from scheduled — record one breach row for human review and do NOT
    // mark fired (design/07 §3:分不清先后按违规计).
    const { rows } = await client.query<{ state: string }>(
      "SELECT state FROM tasks WHERE id = $1",
      [task.id],
    );
    const current = rows[0]?.state ?? task.state;
    if (current === "cancel_pending" || current === "cancelled") {
      await recordCancelBreach(client, {
        ownerId: task.owner_id,
        taskId: task.id,
        evidenceRef: delivery.providerReceiptId ?? row.idempotency_key,
      });
      await markOutboxSuperseded(client, row.id);
      return "breaches";
    }
    const moved = await transitionTask(client, {
      taskId: task.id,
      fromStates: ["scheduled"],
      toState: "fired",
      expectedVersion: task.state_version,
    });
    if (!moved) {
      await markOutboxSuperseded(client, row.id);
      return "superseded";
    }
    await appendTaskEvent(client, {
      ownerId: task.owner_id,
      taskId: task.id,
      stateVersion: task.state_version + 1,
      type: "fired",
      evidenceRef: delivery.providerReceiptId ?? row.idempotency_key,
    });
    await supersedeQueuedOutboxForTask(client, task.id);
    await markOutboxDispatched(client, row.id, delivery.providerReceiptId);
    return "fired";
  }

  if (outcome === "ack_unknown") {
    const nextDelay = ackDelayForCheck(row.ack_check_no);
    if (nextDelay === null) {
      // Checks exhausted: persistent reconciliation marker (design/08 §4).
      await markOutboxFailedDeadline(client, row.id, "ack_unknown checks exhausted");
      return "failedDeadline";
    }
    await markOutboxAckUnknown(client, {
      outboxId: row.id,
      ackCheckNo: row.ack_check_no + 1,
      nextCheckAt: new Date(nowMs + nextDelay),
      lastError: "ack_unknown",
    });
    return "ackUnknown";
  }

  // Provider refused: retry with backoff while attempts remain.
  const nextDelay = backoffMsForAttempt(row.attempt_no);
  if (nextDelay === null) {
    await markOutboxFailedDeadline(client, row.id, "send attempts exhausted");
    return "failedDeadline";
  }
  await bumpOutboxAttempt(client, {
    outboxId: row.id,
    attemptNo: row.attempt_no + 1,
    nextAttemptAt: new Date(nowMs + nextDelay),
    lastError: "provider refused",
  });
  return "retried";
}

export async function runSendPhase(
  pool: Pool,
  provider?: InAppProvider,
  nowMs: number = Date.now(),
): Promise<SendSummary> {
  const summary: SendSummary = {
    scanned: 0,
    fired: 0,
    retried: 0,
    ackUnknown: 0,
    superseded: 0,
    failedDeadline: 0,
    breaches: 0,
  };
  const rows = await collectDueSend(pool);
  for (const row of rows) {
    const disposition = await withTransaction(pool, async (client: PoolClient) => {
      // Lock order (task before outbox): first verify the task is still
      // claimable without locking, then take the task lock, and only then
      // lock the outbox row. requestCancel holds the task lock through its
      // whole step, so outbox-first ordering here would form a task↔outbox
      // lock cycle (40P01) under concurrency. Re-check the outbox row after
      // both locks: a concurrent cancel may have superseded it.
      const probe = await client.query<{ status: string }>(
        "SELECT status FROM outbox WHERE id = $1",
        [row.id],
      );
      if (!probe.rows[0] || probe.rows[0].status !== "dispatched") return null;
      const taskProbe = await client.query<{ id: string }>(
        "SELECT id FROM tasks WHERE id = $1",
        [row.task_id],
      );
      if (!taskProbe.rows[0]) return null;
      await client.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [row.task_id]);
      const locked = await lockOutboxRow(client, row.id);
      if (!locked || locked.status !== "dispatched") return null;
      return sendOne(client, locked, provider ?? null, nowMs);
    });
    if (!disposition) continue;
    summary.scanned += 1;
    if (disposition === "fired") summary.fired += 1;
    else if (disposition === "retried") summary.retried += 1;
    else if (disposition === "ackUnknown") summary.ackUnknown += 1;
    else if (disposition === "superseded") summary.superseded += 1;
    else if (disposition === "failedDeadline") summary.failedDeadline += 1;
    else if (disposition === "breaches") summary.breaches += 1;
  }
  return summary;
}

async function collectDueSend(pool: Pool): Promise<OutboxRow[]> {
  const client = await pool.connect();
  try {
    return await listDueSendRows(client, SEND_BATCH_LIMIT);
  } finally {
    client.release();
  }
}
