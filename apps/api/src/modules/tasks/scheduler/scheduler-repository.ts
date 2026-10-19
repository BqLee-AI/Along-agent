// Scheduler repository: raw SQL for the worker role. All phase entry points
// run inside caller-owned transactions; this module owns no BEGIN/COMMIT.
import type { PoolClient } from 'pg';

export interface SchedulerTaskRow {
  id: string;
  owner_id: string;
  state: string;
  state_version: number;
  fire_at_utc: Date;
  wall_time: string;
  timezone_id: string;
  schedule_receipt: string | null;
  original_note: string | null;
}

export interface OutboxRow {
  id: string;
  owner_id: string;
  task_id: string;
  expected_state_version: number;
  command: unknown;
  idempotency_key: string;
  attempt_no: number;
  status: string;
  created_at: Date;
  updated_at: Date;
  last_attempt_at: Date | null;
  ack_check_no: number;
  provider_receipt_id: string | null;
  last_error: string | null;
}

export interface TaskLeaseRow {
  task_id: string;
  owner_id: string;
  expected_state_version: number;
  lease_owner: string;
  lease_expires_at: Date;
}

/** Lock one outbox row for dispatch. Skips rows locked by a peer tick. */
export async function lockOutboxRow(
  client: PoolClient,
  outboxId: string,
): Promise<OutboxRow | null> {
  const { rows } = await client.query<OutboxRow>(
    `SELECT id, owner_id, task_id, expected_state_version, command,
       idempotency_key, attempt_no, status, created_at, updated_at,
       last_attempt_at, ack_check_no, provider_receipt_id, last_error
     FROM outbox WHERE id = $1 FOR UPDATE SKIP LOCKED`,
    [outboxId],
  );
  return rows[0] ?? null;
}

/** Due schedule rows: pending, and either never attempted or backoff elapsed. */
export async function listDueScheduleRows(client: PoolClient, limit: number): Promise<OutboxRow[]> {
  const { rows } = await client.query<OutboxRow>(
    `SELECT id, owner_id, task_id, expected_state_version, command,
       idempotency_key, attempt_no, status, created_at, updated_at,
       last_attempt_at, ack_check_no, provider_receipt_id, last_error
     FROM outbox
     WHERE status = 'pending'
       AND command->>'kind' = 'schedule'
       AND (last_attempt_at IS NULL OR last_attempt_at <= now())
     ORDER BY created_at ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows;
}

/** Lock the task row for a schedule/cancel phase. */
export async function lockTaskRow(
  client: PoolClient,
  taskId: string,
): Promise<SchedulerTaskRow | null> {
  const { rows } = await client.query<SchedulerTaskRow>(
    `SELECT id, owner_id, state, state_version, fire_at_utc, wall_time,
       timezone_id, schedule_receipt, original_note
     FROM tasks WHERE id = $1 FOR UPDATE`,
    [taskId],
  );
  return rows[0] ?? null;
}

/**
 * Claim candidates: scheduled tasks whose fire instant has arrived, with no
 * live lease held by another owner. Lease expiry is compared on the DB clock
 * so kill -9 resume cannot double-fire while a live lease exists.
 */
export async function listClaimCandidates(
  client: PoolClient,
  workerId: string,
  limit: number,
): Promise<SchedulerTaskRow[]> {
  const { rows } = await client.query<SchedulerTaskRow>(
    `SELECT t.id, t.owner_id, t.state, t.state_version, t.fire_at_utc,
       t.wall_time, t.timezone_id, t.schedule_receipt, t.original_note
     FROM tasks t
     LEFT JOIN task_leases l ON l.task_id = t.id
     WHERE t.state = 'scheduled'
       AND t.fire_at_utc <= now()
       AND t.fire_at_utc > now() - interval '15 minutes'
       AND (l.task_id IS NULL
         OR l.lease_expires_at <= now()
         OR l.lease_owner = $1)
     ORDER BY t.fire_at_utc ASC
     LIMIT $2
     FOR UPDATE OF t SKIP LOCKED`,
    [workerId, limit],
  );
  return rows;
}

/** Upsert the claim lease for one task (same transaction as the row lock). */
export async function upsertTaskLease(
  client: PoolClient,
  args: {
    taskId: string;
    ownerId: string;
    expectedStateVersion: number;
    leaseOwner: string;
    expiresAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO task_leases (task_id, owner_id, expected_state_version,
       lease_owner, lease_expires_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (task_id) DO UPDATE SET
       owner_id = EXCLUDED.owner_id,
       expected_state_version = EXCLUDED.expected_state_version,
       lease_owner = EXCLUDED.lease_owner,
       lease_expires_at = EXCLUDED.lease_expires_at`,
    [
      args.taskId,
      args.ownerId,
      args.expectedStateVersion,
      args.leaseOwner,
      args.expiresAt.toISOString(),
    ],
  );
}

/** Tasks past the 15-minute fire window that still await a terminal event. */
export async function listMissedCandidates(
  client: PoolClient,
  limit: number,
): Promise<SchedulerTaskRow[]> {
  const { rows } = await client.query<SchedulerTaskRow>(
    `SELECT id, owner_id, state, state_version, fire_at_utc, wall_time,
       timezone_id, schedule_receipt, original_note
     FROM tasks
     WHERE state IN ('scheduled', 'cancel_pending')
       AND fire_at_utc < now() - interval '15 minutes'
     ORDER BY fire_at_utc ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows;
}

/** Due send rows: dispatched, backoff elapsed, still inside the fire window. */
export async function listDueSendRows(client: PoolClient, limit: number): Promise<OutboxRow[]> {
  const { rows } = await client.query<OutboxRow>(
    `SELECT o.id, o.owner_id, o.task_id, o.expected_state_version, o.command,
       o.idempotency_key, o.attempt_no, o.status, o.created_at, o.updated_at,
       o.last_attempt_at, o.ack_check_no, o.provider_receipt_id, o.last_error
     FROM outbox o
     JOIN tasks t ON t.id = o.task_id
     WHERE o.status = 'dispatched'
       AND o.command->>'kind' = 'send'
       AND (o.last_attempt_at IS NULL OR o.last_attempt_at <= now())
       AND t.fire_at_utc >= now() - interval '15 minutes'
     ORDER BY o.created_at ASC
     LIMIT $1
     FOR UPDATE OF o SKIP LOCKED`,
    [limit],
  );
  return rows;
}

/** Due ack re-check rows: acked_unknown with an elapsed check schedule. */
export async function listDueAckRows(client: PoolClient, limit: number): Promise<OutboxRow[]> {
  const { rows } = await client.query<OutboxRow>(
    `SELECT id, owner_id, task_id, expected_state_version, command,
       idempotency_key, attempt_no, status, created_at, updated_at,
       last_attempt_at, ack_check_no, provider_receipt_id, last_error
     FROM outbox
     WHERE status = 'acked_unknown'
       AND ack_check_no <= 3
       AND (last_attempt_at IS NULL OR last_attempt_at <= now())
     ORDER BY created_at ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows;
}

/** Due cancel rows: pending cancel commands. */
export async function listDueCancelRows(client: PoolClient, limit: number): Promise<OutboxRow[]> {
  const { rows } = await client.query<OutboxRow>(
    `SELECT id, owner_id, task_id, expected_state_version, command,
       idempotency_key, attempt_no, status, created_at, updated_at,
       last_attempt_at, ack_check_no, provider_receipt_id, last_error
     FROM outbox
     WHERE status = 'pending'
       AND command->>'kind' = 'cancel'
       AND (last_attempt_at IS NULL OR last_attempt_at <= now())
     ORDER BY created_at ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows;
}

export async function markOutboxDispatched(
  client: PoolClient,
  outboxId: string,
  providerReceiptId: string | null,
): Promise<void> {
  await client.query(
    `UPDATE outbox SET status = 'dispatched', provider_receipt_id = $2,
       last_attempt_at = now(), updated_at = now()
     WHERE id = $1`,
    [outboxId, providerReceiptId],
  );
}

export async function markOutboxAckUnknown(
  client: PoolClient,
  args: { outboxId: string; ackCheckNo: number; nextCheckAt: Date; lastError: string | null },
): Promise<void> {
  await client.query(
    `UPDATE outbox SET status = 'acked_unknown', ack_check_no = $2,
       last_attempt_at = $3, last_error = $4, updated_at = now()
     WHERE id = $1`,
    [args.outboxId, args.ackCheckNo, args.nextCheckAt.toISOString(), args.lastError],
  );
}

export async function markOutboxSuperseded(client: PoolClient, outboxId: string): Promise<void> {
  await client.query(`UPDATE outbox SET status = 'superseded', updated_at = now() WHERE id = $1`, [
    outboxId,
  ]);
}

export async function markOutboxFailedDeadline(
  client: PoolClient,
  outboxId: string,
  lastError: string,
): Promise<void> {
  await client.query(
    `UPDATE outbox SET status = 'failed_deadline', last_error = $2,
       last_attempt_at = now(), updated_at = now()
     WHERE id = $1`,
    [outboxId, lastError],
  );
}

export async function bumpOutboxAttempt(
  client: PoolClient,
  args: { outboxId: string; attemptNo: number; nextAttemptAt: Date; lastError: string | null },
): Promise<void> {
  await client.query(
    `UPDATE outbox SET attempt_no = $2, last_attempt_at = $3, last_error = $4,
       updated_at = now()
     WHERE id = $1`,
    [args.outboxId, args.attemptNo, args.nextAttemptAt.toISOString(), args.lastError],
  );
}

/** Supersede every queued row for a task (cancel wins over everything). */
// Lock-order contract: this runs AFTER the caller's task-row lock is held,
// matching requestCancel (task lock held through the whole step). Worker
// phases that lock an outbox row before its task row must take the outbox
// lock only after reading the task unlocked — see runSendPhase.
export async function supersedeQueuedOutboxForTask(
  client: PoolClient,
  taskId: string,
): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `UPDATE outbox SET status = 'superseded', updated_at = now()
     WHERE task_id = $1 AND status IN ('pending', 'dispatched', 'acked_unknown')
     RETURNING 1`,
    [taskId],
  );
  return rows.length;
}

export async function transitionTask(
  client: PoolClient,
  args: {
    taskId: string;
    fromStates: string[];
    toState: string;
    expectedVersion: number;
    scheduleReceipt?: string | null;
  },
): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE tasks SET state = $2, state_version = state_version + 1,
       schedule_receipt = COALESCE($5, schedule_receipt)
     WHERE id = $1 AND state = ANY($3) AND state_version = $4
     RETURNING id`,
    [
      args.taskId,
      args.toState,
      args.fromStates,
      args.expectedVersion,
      args.scheduleReceipt ?? null,
    ],
  );
  return rows.length > 0;
}

export async function appendTaskEvent(
  client: PoolClient,
  args: {
    ownerId: string;
    taskId: string;
    stateVersion: number;
    type: string;
    evidenceRef: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO task_events (id, owner_id, task_id, state_version, type, evidence_ref)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [args.ownerId, args.taskId, args.stateVersion, args.type, args.evidenceRef],
  );
}

export async function recordCancelBreach(
  client: PoolClient,
  args: { ownerId: string; taskId: string; evidenceRef: string },
): Promise<void> {
  await client.query(
    `INSERT INTO security_events (id, owner_id, task_id, type, evidence_ref)
     VALUES (gen_random_uuid(), $1, $2, 'cancel_breach', $3)`,
    [args.ownerId, args.taskId, args.evidenceRef],
  );
}
