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
  tzdb_version: string;
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

export interface ToolTaskList {
  tasks: {
    task_id: string;
    note_preview: string;
    fire_at_local_text: string;
    timezone_id: string;
    state: string;
  }[];
  has_more: boolean;
}

const ACTIVE_STATES = ['saved', 'pending_schedule', 'scheduled', 'cancel_pending'] as const;

export async function readToolTaskList(
  client: PoolClient,
  ownerId: string,
  input: { state?: string | null; limit: number },
): Promise<ToolTaskList> {
  const states = input.state ? [input.state] : [...ACTIVE_STATES];
  const { rows } = await client.query<{
    id: string;
    original_note: string | null;
    wall_time: string;
    timezone_id: string;
    state: string;
  }>(
    `SELECT id, original_note, wall_time, timezone_id, state FROM tasks
     WHERE owner_id = $1 AND state = ANY($2::text[])
     ORDER BY fire_at_utc ASC LIMIT $3`,
    [ownerId, states, input.limit + 1],
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
  };
}
