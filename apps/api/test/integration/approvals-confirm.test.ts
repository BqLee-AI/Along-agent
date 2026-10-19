import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  confirmApproval,
  rejectApproval,
} from "../../src/modules/approvals/confirm.js";
import { getApprovalDetail } from "../../src/modules/approvals/service.js";
import { databaseUrl, requirePool, seedApproval } from "./setup.js";

const maybe = databaseUrl ? describe : describe.skip;

async function taskCount(pool: Pool, approvalId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM tasks WHERE source_approval_id = $1",
    [approvalId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function seenEcho(pool: Pool, ownerId: string, approvalId: string): Promise<string> {
  const { detail } = await getApprovalDetail({ pool }, ownerId, approvalId);
  return detail.echo_text;
}

maybe("approvals confirm transaction", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = requirePool();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("confirms once: task(saved v1) + created event + outbox(pending) + consumed", async () => {
    const seed = await seedApproval(pool, {});
    const body = {
      presentation_hash: seed.presentationHash,
      seen_content: await seenEcho(pool, seed.ownerId, seed.id),
      idempotency_key: randomUUID(),
    };
    const result = await confirmApproval({ pool }, seed.ownerId, seed.id, body);
    expect(result).toMatchObject({
      approval_id: seed.id,
      status: "consumed",
      duplicate: false,
    });
    expect(result.task_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const { rows: tasks } = await pool.query(
      "SELECT state, state_version, original_note FROM tasks WHERE id = $1",
      [result.task_id],
    );
    expect(tasks[0]).toMatchObject({
      state: "saved",
      state_version: 1,
      original_note: "明天 9:20 喝水",
    });
    const { rows: events } = await pool.query(
      "SELECT type, state_version, evidence_ref FROM task_events WHERE task_id = $1",
      [result.task_id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "created",
      state_version: 1,
      evidence_ref: "local",
    });
    const { rows: outbox } = await pool.query(
      "SELECT status, expected_state_version FROM outbox WHERE task_id = $1",
      [result.task_id],
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: "pending", expected_state_version: 1 });
    const { rows: approvals } = await pool.query(
      "SELECT state, consumed_task_id FROM approvals WHERE id = $1",
      [seed.id],
    );
    expect(approvals[0]).toMatchObject({
      state: "consumed",
      consumed_task_id: result.task_id,
    });
  });

  it("repeat confirm on the same approval returns the original task", async () => {
    const seed = await seedApproval(pool, {});
    const echo = await seenEcho(pool, seed.ownerId, seed.id);
    const first = await confirmApproval({ pool }, seed.ownerId, seed.id, {
      presentation_hash: seed.presentationHash,
      seen_content: echo,
      idempotency_key: randomUUID(),
    });
    const second = await confirmApproval({ pool }, seed.ownerId, seed.id, {
      presentation_hash: seed.presentationHash,
      seen_content: echo,
      idempotency_key: randomUUID(),
    });
    expect(second).toMatchObject({
      approval_id: seed.id,
      status: "consumed",
      task_id: first.task_id,
      duplicate: true,
    });
    expect(await taskCount(pool, seed.id)).toBe(1);
  });

  it("same idempotency key on a sibling approval is a separate operation", async () => {
    const owner = randomUUID();
    const a = await seedApproval(pool, { ownerId: owner });
    const key = randomUUID();
    const first = await confirmApproval({ pool }, owner, a.id, {
      presentation_hash: a.presentationHash,
      seen_content: await seenEcho(pool, owner, a.id),
      idempotency_key: key,
    });
    // Keys are scoped per approval: reusing the client key on B builds B's
    // own task instead of replaying A's.
    const b = await seedApproval(pool, { ownerId: owner });
    const second = await confirmApproval({ pool }, owner, b.id, {
      presentation_hash: b.presentationHash,
      seen_content: await seenEcho(pool, owner, b.id),
      idempotency_key: key,
    });
    expect(second).toMatchObject({
      approval_id: b.id,
      status: "consumed",
      duplicate: false,
    });
    expect(second.task_id).not.toBe(first.task_id);
    expect(await taskCount(pool, a.id)).toBe(1);
    expect(await taskCount(pool, b.id)).toBe(1);
  });

  it("concurrent double confirm produces exactly 1 task", async () => {
    const seed = await seedApproval(pool, {});
    const echo = await seenEcho(pool, seed.ownerId, seed.id);
    const attempt = () =>
      confirmApproval({ pool }, seed.ownerId, seed.id, {
        presentation_hash: seed.presentationHash,
        seen_content: echo,
        idempotency_key: randomUUID(),
      });
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    expect(r1.task_id).toBe(r2.task_id);
    expect([r1.duplicate, r2.duplicate].sort()).toEqual([false, true]);
    expect(await taskCount(pool, seed.id)).toBe(1);
  });

  it("wrong hash is PRESENTATION_MISMATCH 409 and builds no task", async () => {
    const seed = await seedApproval(pool, {});
    await expect(
      confirmApproval({ pool }, seed.ownerId, seed.id, {
        presentation_hash: "ph_deadbeef",
        seen_content: await seenEcho(pool, seed.ownerId, seed.id),
        idempotency_key: randomUUID(),
      }),
    ).rejects.toMatchObject({
      httpStatus: 409,
      code: 400001,
      errorCode: "PRESENTATION_MISMATCH",
    });
    expect(await taskCount(pool, seed.id)).toBe(0);
  });

  it("wrong seen content is PRESENTATION_MISMATCH 409 and builds no task", async () => {
    const seed = await seedApproval(pool, {});
    await expect(
      confirmApproval({ pool }, seed.ownerId, seed.id, {
        presentation_hash: seed.presentationHash,
        seen_content: "有人篡改过的回显",
        idempotency_key: randomUUID(),
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 400001 });
    expect(await taskCount(pool, seed.id)).toBe(0);
  });

  it("expired approval is APPROVAL_EXPIRED 410 and builds no task", async () => {
    const seed = await seedApproval(pool, { expiresInHours: -1 });
    await expect(
      confirmApproval({ pool }, seed.ownerId, seed.id, {
        presentation_hash: seed.presentationHash,
        seen_content: "whatever",
        idempotency_key: randomUUID(),
      }),
    ).rejects.toMatchObject({
      httpStatus: 410,
      code: 400002,
      errorCode: "APPROVAL_EXPIRED",
    });
    expect(await taskCount(pool, seed.id)).toBe(0);
    // Phase-0 persists the lazy expiry: stored state flips to expired.
    const { rows } = await pool.query<{ state: string }>(
      "SELECT state FROM approvals WHERE id = $1",
      [seed.id],
    );
    expect(rows[0]?.state).toBe("expired");
  });

  it("superseded approval is APPROVAL_SUPERSEDED 409 with successor, no task", async () => {
    const old = await seedApproval(pool, { state: "superseded" });
    const successorId = randomUUID();
    await pool.query(
      `INSERT INTO approvals (id, owner_id, original_text, fire_at_utc, wall_time,
         timezone_id, fold, resolved_utc_offset_seconds, tzdb_version, occurrence,
         presentation_hash, presentation_version, state, expires_at, supersedes_approval_id)
       VALUES ($1,$2,'x', now() + interval '25 hours','2026-10-17 09:20',
         'Asia/Shanghai',0,28800,'2024a','single','ph_x','v1','pending',
         now() + interval '23 hours',$3)`,
      [successorId, old.ownerId, old.id],
    );
    const err = await confirmApproval(
      { pool },
      old.ownerId,
      old.id,
      {
        presentation_hash: "ph_x",
        seen_content: "x",
        idempotency_key: randomUUID(),
      },
    ).then(
      () => null,
      (e: { httpStatus?: number; code?: number; details?: unknown }) => e,
    );
    expect(err).toMatchObject({ httpStatus: 409, code: 400003 });
    expect(err?.details).toMatchObject({ successor_approval_id: successorId });
    expect(await taskCount(pool, old.id)).toBe(0);
  });

  it("missing body fields are 400, unknown/cross-owner are 404/403", async () => {
    const seed = await seedApproval(pool, {});
    await expect(
      confirmApproval({ pool }, seed.ownerId, seed.id, {
        presentation_hash: seed.presentationHash,
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      confirmApproval({ pool }, seed.ownerId, randomUUID(), {
        presentation_hash: seed.presentationHash,
        seen_content: "x",
        idempotency_key: randomUUID(),
      }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    await expect(
      confirmApproval({ pool }, randomUUID(), seed.id, {
        presentation_hash: seed.presentationHash,
        seen_content: "x",
        idempotency_key: randomUUID(),
      }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    expect(await taskCount(pool, seed.id)).toBe(0);
  });

  it("reject flips pending to rejected; repeat replays duplicate", async () => {
    const seed = await seedApproval(pool, {});
    const key = randomUUID();
    const first = await rejectApproval({ pool }, seed.ownerId, seed.id, {
      idempotency_key: key,
    });
    expect(first).toMatchObject({
      approval_id: seed.id,
      status: "rejected",
      duplicate: false,
    });
    const second = await rejectApproval({ pool }, seed.ownerId, seed.id, {
      idempotency_key: randomUUID(),
    });
    expect(second).toMatchObject({ status: "rejected", duplicate: true });
    expect(await taskCount(pool, seed.id)).toBe(0);
  });

  it("reject after consumed is 409 with the task reference", async () => {
    const seed = await seedApproval(pool, {});
    const done = await confirmApproval({ pool }, seed.ownerId, seed.id, {
      presentation_hash: seed.presentationHash,
      seen_content: await seenEcho(pool, seed.ownerId, seed.id),
      idempotency_key: randomUUID(),
    });
    const err = await rejectApproval({ pool }, seed.ownerId, seed.id, {
      idempotency_key: randomUUID(),
    }).then(
      () => null,
      (e: { httpStatus?: number; code?: number; details?: unknown }) => e,
    );
    expect(err).toMatchObject({ httpStatus: 409, code: 400010 });
    expect(err?.details).toMatchObject({ task_id: done.task_id });
  });

  it("confirm after rejected is 409 STATE_CONFLICT, no task", async () => {
    const seed = await seedApproval(pool, { state: "rejected" });
    await expect(
      confirmApproval({ pool }, seed.ownerId, seed.id, {
        presentation_hash: seed.presentationHash,
        seen_content: "x",
        idempotency_key: randomUUID(),
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 400010 });
    expect(await taskCount(pool, seed.id)).toBe(0);
  });
});
