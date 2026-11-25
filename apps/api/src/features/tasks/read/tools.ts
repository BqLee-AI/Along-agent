import type { PoolClient } from 'pg';

export interface CancelTaskCandidate {
  id: string;
  owner_id: string;
  state: string;
  state_version: number;
  wall_time: string;
  timezone_id: string;
  fold: number;
  resolved_utc_offset_seconds: number;
  tzdb_version: string | null;
  fire_at_utc: Date;
  original_note: string | null;
}

// Public query-client projections deliberately share the caller's transaction.
// The HTTP task DTO omits metadata required to freeze a cancellation approval.
export async function readCancelTaskCandidate(
  client: PoolClient,
  ownerId: string,
  taskId: string,
): Promise<CancelTaskCandidate | null> {
  const { rows } = await client.query<CancelTaskCandidate>(
    `SELECT id, owner_id, state, state_version, wall_time, timezone_id, fold,
       resolved_utc_offset_seconds, tzdb_version, fire_at_utc, original_note
     FROM tasks WHERE id = $1 AND owner_id = $2`,
    [taskId, ownerId],
  );
  return rows[0] ?? null;
}

// Include pending revocations so a multi-target request cannot become
// artificially unique as earlier cancellation requests are accepted.
export async function readActiveSameNoteTasks(
  client: PoolClient,
  ownerId: string,
  note: string | null,
): Promise<{ id: string; wall_time: string; timezone_id: string }[]> {
  return (
    await client.query<{ id: string; wall_time: string; timezone_id: string }>(
      `SELECT id, wall_time, timezone_id FROM tasks
       WHERE owner_id=$1 AND original_note IS NOT DISTINCT FROM $2
         AND state IN ('saved','pending_schedule','scheduled','cancel_pending')
       ORDER BY fire_at_utc,id`,
      [ownerId, note],
    )
  ).rows;
}

export async function readRepeatedNotesMentioned(
  client: PoolClient,
  ownerId: string,
  input: string,
): Promise<string[]> {
  const { rows } = await client.query<{ original_note: string }>(
    `SELECT original_note FROM tasks
     WHERE owner_id=$1 AND original_note IS NOT NULL AND original_note<>''
       AND strpos($2,original_note)>0
       AND state IN ('saved','pending_schedule','scheduled','cancel_pending')
     GROUP BY original_note HAVING count(*)>1 LIMIT 2`,
    [ownerId, input],
  );
  return rows.map((row) => row.original_note);
}

export interface ToolTaskList {
  tasks: {
    task_id: string;
    note_preview: string;
    fire_at_local_text: string;
    timezone_id: string;
    state: string;
  }[];
  has_more: boolean;
  next_cursor?: string | null;
}

const ACTIVE_STATES = ['saved', 'pending_schedule', 'scheduled', 'cancel_pending'] as const;

export async function readToolTaskList(
  client: PoolClient,
  ownerId: string,
  input: {
    state?: string | null;
    limit: number;
    paginate?: boolean;
    after_task_id?: string;
    future_after?: string;
  },
): Promise<ToolTaskList> {
  const states = input.state ? [input.state] : [...ACTIVE_STATES];
  if (input.after_task_id) {
    const cursor = await client.query('SELECT id FROM tasks WHERE owner_id = $1 AND id = $2', [
      ownerId,
      input.after_task_id,
    ]);
    if (!cursor.rows.length) throw new Error('invalid task cursor');
  }
  const { rows } = await client.query<{
    id: string;
    original_note: string | null;
    wall_time: string;
    timezone_id: string;
    state: string;
  }>(
    `SELECT id, original_note, wall_time, timezone_id, state FROM tasks
     WHERE owner_id = $1 AND state = ANY($2::text[])
       AND ($5::timestamptz IS NULL OR fire_at_utc > $5::timestamptz)
       AND ($4::uuid IS NULL OR (fire_at_utc, id) >
         (SELECT fire_at_utc, id FROM tasks WHERE owner_id = $1 AND id = $4))
     ORDER BY fire_at_utc ASC, id ASC LIMIT $3`,
    [ownerId, states, input.limit + 1, input.after_task_id ?? null, input.future_after ?? null],
  );
  return {
    tasks: rows.slice(0, input.limit).map((row) => ({
      task_id: row.id,
      note_preview: (row.original_note ?? '').slice(0, 30),
      fire_at_local_text: row.wall_time,
      timezone_id: row.timezone_id,
      state: row.state,
    })),
    has_more: rows.length > input.limit,
    ...(input.paginate
      ? { next_cursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null }
      : {}),
  };
}
