import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { stateConflict } from '../../platform/errors.js';
import { appendTaskEvent } from './task-event-ledger.js';

export type TaskCreationSource =
  | { approvalId: string; invocationId?: never }
  | { invocationId: string; approvalId?: never };

export interface ElapsedTimeBasis {
  kind: 'elapsed';
  anchor_utc: string;
  duration_seconds: number;
  source_message_id: string;
  revision: 'elapsed/1';
}

export interface CreateTaskInput {
  ownerId: string;
  source: TaskCreationSource;
  fireAtUtc: string;
  wallTime: string;
  timezoneId: string;
  fold: 0 | 1;
  resolvedUtcOffsetSeconds: number;
  tzdbVersion: string | null;
  timeBasis?: ElapsedTimeBasis | null;
  displayVersion?: 'elapsed/1' | null;
  originalNote: string | null;
  idempotencyKey: string;
}

export interface CreatedTaskReceipt {
  task_id: string;
  state: 'saved';
  wall_time: string;
  timezone_id: string;
  fold: 0 | 1;
  resolved_utc_offset_seconds: number;
  tzdb_version: string | null;
  time_basis?: ElapsedTimeBasis;
  display_version?: 'elapsed/1';
  fire_at_utc: string;
  original_note: string | null;
}

async function requireFutureFireTime(client: PoolClient, fireAtUtc: string): Promise<void> {
  const { rows } = await client.query<{ future: boolean }>(
    'SELECT $1::timestamptz > clock_timestamp() AS future',
    [fireAtUtc],
  );
  if (!rows[0]?.future) {
    throw stateConflict('frozen fire time has passed', { reason: 'FIRE_TIME_PASSED' });
  }
}

// Serialize task insertion with cancellation target discovery for one owner.
// The transaction owns the lock, including any later task/event/outbox writes.
export async function lockTaskCreationScope(client: PoolClient, ownerId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('task-scope:' || $1, 0))", [
    ownerId,
  ]);
}

/**
 * Caller owns the transaction and validates its source's owner/authorization.
 * Frozen time-core facts are copied, never recalculated. Any error must escape
 * the caller's transaction so task, event, command and caller effects roll back.
 */
export async function createTaskWithinTransaction(
  client: PoolClient,
  input: CreateTaskInput,
): Promise<CreatedTaskReceipt> {
  await lockTaskCreationScope(client, input.ownerId);
  await requireFutureFireTime(client, input.fireAtUtc);
  const taskId = randomUUID();
  const { rows } = await client.query<{ fire_at_utc: Date }>(
    `INSERT INTO tasks (id, owner_id, kind, source_approval_id, source_invocation_id,
       fire_at_utc, wall_time, timezone_id, fold, resolved_utc_offset_seconds,
       tzdb_version, occurrence, state, state_version, original_note, time_basis, display_version)
     VALUES ($1,$2,'notify_only',$3,$4,$5,$6,$7,$8,$9,$10,'once','saved',1,$11,$12::jsonb,$13)
     RETURNING fire_at_utc`,
    [
      taskId,
      input.ownerId,
      input.source.approvalId ?? null,
      input.source.invocationId ?? null,
      input.fireAtUtc,
      input.wallTime,
      input.timezoneId,
      input.fold,
      input.resolvedUtcOffsetSeconds,
      input.tzdbVersion,
      input.originalNote,
      input.timeBasis ? JSON.stringify(input.timeBasis) : null,
      input.timeBasis ? (input.displayVersion ?? 'elapsed/1') : null,
    ],
  );
  const fireAtUtc = rows[0]!.fire_at_utc.toISOString();
  await appendTaskEvent(client, {
    ownerId: input.ownerId,
    taskId,
    stateVersion: 1,
    type: 'created',
    evidenceRef: 'local',
  });
  await client.query(
    `INSERT INTO outbox (id, owner_id, task_id, expected_state_version, command,
       idempotency_key, status)
     VALUES (gen_random_uuid(), $1, $2, 1, $3, $4, 'pending')`,
    [
      input.ownerId,
      taskId,
      JSON.stringify({
        kind: 'schedule',
        task_id: taskId,
        fire_at_utc: fireAtUtc,
        timezone_id: input.timezoneId,
        expected_state_version: 1,
        idempotency_key: input.idempotencyKey,
      }),
      input.idempotencyKey,
    ],
  );
  // Use the live DB clock again after all potentially blocking writes.
  await requireFutureFireTime(client, fireAtUtc);
  return {
    task_id: taskId,
    state: 'saved',
    wall_time: input.wallTime,
    timezone_id: input.timezoneId,
    fold: input.fold,
    resolved_utc_offset_seconds: input.resolvedUtcOffsetSeconds,
    tzdb_version: input.tzdbVersion,
    fire_at_utc: fireAtUtc,
    original_note: input.originalNote,
    ...(input.timeBasis
      ? { time_basis: input.timeBasis, display_version: input.displayVersion ?? 'elapsed/1' }
      : {}),
  };
}

/** Read accepted creation facts, not a claim that the current state is saved. */
export async function readCreatedTaskReceipt(
  client: PoolClient,
  input: { ownerId: string; invocationId: string },
): Promise<CreatedTaskReceipt | null> {
  const { rows } = await client.query<
    Omit<CreatedTaskReceipt, 'state' | 'fire_at_utc' | 'time_basis' | 'display_version'> & {
      fire_at_utc: Date;
      time_basis: ElapsedTimeBasis | null;
      display_version: 'elapsed/1' | null;
    }
  >(
    `SELECT t.id AS task_id, t.wall_time, t.timezone_id, t.fold,
       t.resolved_utc_offset_seconds, t.tzdb_version, t.fire_at_utc, t.original_note,
       t.time_basis, t.display_version
     FROM tasks t
     WHERE t.owner_id=$1 AND t.source_invocation_id=$2
       AND EXISTS (SELECT 1 FROM task_events e WHERE e.task_id=t.id
         AND e.owner_id=t.owner_id AND e.type='created' AND e.state_version=1)`,
    [input.ownerId, input.invocationId],
  );
  const row = rows[0];
  if (!row) return null;
  const { time_basis, display_version, ...facts } = row;
  return {
    ...facts,
    state: 'saved',
    fire_at_utc: row.fire_at_utc.toISOString(),
    ...(time_basis && display_version ? { time_basis, display_version } : {}),
  };
}
