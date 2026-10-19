import type { PoolClient } from 'pg';

export interface TaskRow {
  id: string;
  owner_id: string;
  kind: string;
  source_approval_id: string | null;
  recreated_from_task_id: string | null;
  fire_at_utc: Date;
  wall_time: string;
  timezone_id: string;
  fold: number;
  resolved_utc_offset_seconds: number;
  tzdb_version: string;
  occurrence: string;
  state: string;
  state_version: number;
  schedule_receipt: string | null;
  original_note: string | null;
  created_at: Date;
}

export interface TaskEventRow {
  id: string;
  owner_id: string;
  task_id: string;
  state_version: number;
  type: string;
  recorded_at_utc: Date;
  evidence_ref: string;
}

export interface TaskListFilter {
  ownerId: string;
  status: string; // task state | all
  limit: number;
  cursor?: { fireAt: string; id: string };
}

export async function listTasks(client: PoolClient, filter: TaskListFilter): Promise<TaskRow[]> {
  const params: unknown[] = [filter.ownerId];
  const where: string[] = ['owner_id = $1'];
  if (filter.status !== 'all') {
    params.push(filter.status);
    where.push(`state = $${params.length}`);
  }
  if (filter.cursor) {
    params.push(filter.cursor.fireAt, filter.cursor.id);
    where.push(`(fire_at_utc, id) > ($${params.length - 1}, $${params.length})`);
  }
  params.push(filter.limit + 1);
  const { rows } = await client.query<TaskRow & { fire_at_cursor: string }>(
    `SELECT *, to_char(fire_at_utc, 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS fire_at_cursor ` +
      `FROM tasks WHERE ${where.join(' AND ')} ` +
      `ORDER BY fire_at_utc ASC, id ASC LIMIT $${params.length}`,
    params as never[],
  );
  for (const row of rows) {
    row.fire_at_utc = new Date(row.fire_at_cursor);
  }
  return rows;
}

export type TaskLookup =
  | { found: false }
  | { found: true; forbidden: true }
  | { found: true; forbidden: false; row: TaskRow };

export async function getTask(
  client: PoolClient,
  ownerId: string,
  taskId: string,
): Promise<TaskLookup> {
  const { rows } = await client.query<TaskRow>('SELECT * FROM tasks WHERE id = $1', [taskId]);
  const row = rows[0];
  if (!row) return { found: false };
  if (row.owner_id !== ownerId) return { found: true, forbidden: true };
  return { found: true, forbidden: false, row };
}

export async function listTaskEvents(
  client: PoolClient,
  taskId: string,
  limit: number,
  cursor?: { recordedAt: string; id: string },
): Promise<TaskEventRow[]> {
  const params: unknown[] = [taskId];
  const where: string[] = ['task_id = $1'];
  if (cursor) {
    params.push(cursor.recordedAt, cursor.id);
    where.push(`(recorded_at_utc, id) > ($${params.length - 1}, $${params.length})`);
  }
  params.push(limit + 1);
  const { rows } = await client.query<TaskEventRow & { recorded_at_cursor: string }>(
    `SELECT *, to_char(recorded_at_utc, 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS recorded_at_cursor ` +
      `FROM task_events WHERE ${where.join(' AND ')} ` +
      `ORDER BY recorded_at_utc ASC, id ASC LIMIT $${params.length}`,
    params as never[],
  );
  for (const row of rows) {
    row.recorded_at_utc = new Date(row.recorded_at_cursor);
  }
  return rows;
}
