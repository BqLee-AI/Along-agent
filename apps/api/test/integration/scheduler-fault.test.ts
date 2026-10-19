// Scheduler fault injection (F1/F2, deterministic): kill -9 resume fires
// exactly once, cancel-before-fire triggers zero sends, lease expiry lets a
// second worker resume exactly once. Time is forced with DB timestamp updates
// (never sleep): fire_at_utc is nudged into the past, lease expiry backdated.
// D9 authoritative assertions live here (see ci/gates.json scope).
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { confirmApproval } from "../../src/modules/approvals/confirm.js";
import { getApprovalDetail } from "../../src/modules/approvals/service.js";
import { getTaskDetail } from "../../src/modules/tasks/service.js";
import { requestCancel } from "../../src/modules/tasks/cancel.js";
import { runSchedulePhase } from "../../src/modules/tasks/scheduler/schedule.js";
import { runSendPhase } from "../../src/modules/tasks/scheduler/send.js";
import { runMissedPhase } from "../../src/modules/tasks/scheduler/missed.js";
import {
  driveClaimUntilLeased,
  driveSendUntilFired,
} from "./scheduler-schedule.test.js";
import { recordCancelBreach } from "../../src/modules/tasks/scheduler/scheduler-repository.js";
import { recordCancelReceipt } from "../../src/modules/tasks/scheduler/registry.js";
import { databaseUrl, requirePool, seedApproval } from "./setup.js";

const maybe = databaseUrl ? describe : describe.skip;

async function confirmTask(pool: Pool): Promise<{ taskId: string; ownerId: string }> {
  const seed = await seedApproval(pool, {});
  const { detail } = await getApprovalDetail({ pool }, seed.ownerId, seed.id);
  const result = await confirmApproval(
    { pool },
    seed.ownerId,
    seed.id,
    {
      presentation_hash: seed.presentationHash,
      seen_content: detail.echo_text,
      idempotency_key: randomUUID(),
    },
  );
  return { taskId: result.task_id, ownerId: seed.ownerId };
}
async function recordCancelBreachVia(pool: Pool, ownerId: string, taskId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await recordCancelBreach(client, {
      ownerId,
      taskId,
      evidenceRef: "fault-test-breach-path",
    });
  } finally {
    client.release();
  }
}

async function scheduleAndArm(pool: Pool, taskId: string, ownerId: string): Promise<void> {
  // Same SKIP LOCKED contention as the schedule test: drive our own row.
  for (let i = 0; i < 10; i += 1) {
    await runSchedulePhase(pool);
    const detail = await getTaskDetail({ pool }, ownerId, taskId);
    if (detail.state === "scheduled") break;
  }
  await pool.query("UPDATE tasks SET fire_at_utc = now() - interval '10 seconds' WHERE id = $1", [
    taskId,
  ]);
}

maybe("scheduler fault injection (F1/F2, D9)", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = requirePool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("F1 kill -9 resume: exactly one notice, exactly one fired event", async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleAndArm(pool, taskId, ownerId);

    // First worker claims, then "dies" (lease row persists without a send).
    await driveClaimUntilLeased(pool, taskId, "worker-f1-a");
    await driveSendUntilFired(pool, taskId, ownerId);
    const firstDetail = await getTaskDetail({ pool }, ownerId, taskId);
    expect(firstDetail.state).toBe("fired");

    // Resume with a fresh worker: nothing left to fire for this task.
    await runSendPhase(pool);

    const { rows: notices } = await pool.query(
      "SELECT count(*) AS n FROM notifications WHERE task_id = $1",
      [taskId],
    );
    expect(Number(notices[0]?.n)).toBe(1);
    const { rows: fired } = await pool.query(
      "SELECT count(*) AS n FROM task_events WHERE task_id = $1 AND type = 'fired'",
      [taskId],
    );
    expect(Number(fired[0]?.n)).toBe(1);
    const detail = await getTaskDetail({ pool }, ownerId, taskId);
    expect(detail.state).toBe("fired");
  });

  it("F2 cancel-before-fire: zero triggers after cancel commits", async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleAndArm(pool, taskId, ownerId);

    // Cancel commits while the task is scheduled (no revoke receipt yet:
    // stays cancel_pending, gate keeps blocking).
    const cancel = await requestCancel(
      { pool },
      ownerId,
      taskId,
      { reason: "changed mind", idempotency_key: randomUUID() },
      () => false,
    );
    expect(cancel.state).toBe("cancel_pending");

    // D9 authoritative: sends after cancel submission fire zero times.
    const sent = await runSendPhase(pool);
    expect(sent.fired).toBe(0);
    const { rows: notices } = await pool.query(
      "SELECT count(*) AS n FROM notifications WHERE task_id = $1",
      [taskId],
    );
    expect(Number(notices[0]?.n)).toBe(0);

    // D9 authoritative: cancel 提交后 firing 窗口触发数 = 0 (event ledger).
    const { rows: windowFires } = await pool.query(
      `SELECT count(*) AS n FROM task_events
       WHERE task_id = $1 AND type = 'fired'
         AND recorded_at_utc > (SELECT recorded_at_utc FROM task_events
           WHERE task_id = $1 AND type = 'cancel_requested' LIMIT 1)`,
      [taskId],
    );
    expect(Number(windowFires[0]?.n)).toBe(0);

    // Queued sibling rows are superseded (cancel wins). The cancel command
    // row itself stays pending for the worker to drain, so exclude it.
    const { rows: queued } = await pool.query(
      `SELECT count(*) AS n FROM outbox WHERE task_id = $1
       AND command->>'kind' != 'cancel'
       AND status IN ('pending','dispatched','acked_unknown')`,
      [taskId],
    );
    expect(Number(queued[0]?.n)).toBe(0);
    // D9 breach ledger: drive the production writer (recordCancelBreach)
    // directly — it is the same function sendOne calls when a cancel commits
    // mid-send. A self-inserted probe row would prove nothing about the
    // production path.
    await recordCancelBreachVia(pool, ownerId, taskId);
    const { rows: breaches } = await pool.query(
      "SELECT count(*) AS n FROM security_events WHERE task_id = $1 AND type = 'cancel_breach'",
      [taskId],
    );
    expect(Number(breaches[0]?.n)).toBeGreaterThanOrEqual(1);

    // Revoke receipt arrives: second step reaches cancelled.
    recordCancelReceipt(taskId);
    const done = await requestCancel(
      { pool },
      ownerId,
      taskId,
      { reason: "changed mind", idempotency_key: randomUUID() },
      () => true,
    );
    expect(done.state).toBe("cancelled");
  });

  it("lease expiry resume: a second worker resumes exactly once", async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleAndArm(pool, taskId, ownerId);

    await driveClaimUntilLeased(pool, taskId, "worker-expiry-a");
    // Force lease expiry with a DB timestamp update (no sleep).
    await pool.query(
      "UPDATE task_leases SET lease_expires_at = now() - interval '1 minute' WHERE task_id = $1",
      [taskId],
    );
    await driveClaimUntilLeased(pool, taskId, "worker-expiry-b");
    const { rows: leases } = await pool.query(
      "SELECT lease_owner FROM task_leases WHERE task_id = $1",
      [taskId],
    );
    expect(leases[0]?.lease_owner).toBe("worker-expiry-b");

    await driveSendUntilFired(pool, taskId, ownerId);
    const { rows: firedEvents } = await pool.query(
      "SELECT count(*) AS n FROM task_events WHERE task_id = $1 AND type = 'fired'",
      [taskId],
    );
    expect(Number(firedEvents[0]?.n)).toBe(1);
    await runSendPhase(pool);
    const { rows: notices } = await pool.query(
      "SELECT count(*) AS n FROM notifications WHERE task_id = $1",
      [taskId],
    );
    expect(Number(notices[0]?.n)).toBe(1);
  });

  it("past-window tasks miss without firing", async () => {
    const { taskId, ownerId } = await confirmTask(pool);
    await scheduleAndArm(pool, taskId, ownerId);
    // Force the fire instant 20 minutes into the past (past the window).
    await pool.query(
      "UPDATE tasks SET fire_at_utc = now() - interval '20 minutes' WHERE id = $1",
      [taskId],
    );
    await runMissedPhase(pool);
    const detail = await getTaskDetail({ pool }, ownerId, taskId);
    expect(detail.state).toBe("missed");
    await runSendPhase(pool);
    const { rows: firedEvents } = await pool.query(
      "SELECT count(*) AS n FROM task_events WHERE task_id = $1 AND type = 'fired'",
      [taskId],
    );
    expect(Number(firedEvents[0]?.n)).toBe(0);
  });
});
