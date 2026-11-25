import type { Pool, PoolClient } from 'pg';
import { withClient } from '../../../db/transaction.js';
import { getTaskNotifications, type TaskNotification } from '../../notifications/public.js';
import {
  decodeCursor,
  encodeCursor,
  forbidden,
  isUuid,
  notFound,
  notReady,
  validationError,
  type ApplicationError,
} from '../../../platform/errors.js';
import { getTask, listTaskEvents, listTasks } from './repository.js';
import type { ElapsedTimeBasis } from '../create.js';
import { TaskEventsQuerySchema, TaskListQuerySchema } from '../schemas.js';

// Reads the task associated with a scheduling outbox key on the caller's transaction.
export async function findOutboxTaskByKey(
  client: PoolClient,
  idempotencyKey: string,
): Promise<string | null> {
  const { rows } = await client.query<{ task_id: string }>(
    'SELECT task_id FROM outbox WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  return rows[0]?.task_id ?? null;
}

export interface Deps {
  pool: Pool | null;
}

export interface TaskListItem {
  task_id: string;
  state: string;
  fire_at_utc: string;
  fire_at_local: string;
  timezone_id: string;
  fold: number;
  resolved_utc_offset_seconds: number;
  tzdb_version: string | null;
  time_basis: ElapsedTimeBasis | null;
  display_version: 'elapsed/1' | null;
  source_approval_id: string | null;
  source_invocation_id: string | null;
  schedule_receipt: string | null;
}

export interface TaskDetail extends TaskListItem {
  kind: string;
  state_version: number;
  recreated_from: string | null;
  created_at: string;
  notifications: TaskNotification[];
}

export interface TaskEventItem {
  event_id: string;
  type: string;
  recorded_at_utc: string;
  state_version: number;
  evidence_ref: string;
}

function requirePool(deps: Deps): Pool {
  if (!deps.pool) throw notReady();
  return deps.pool;
}

function taskListItem(row: Awaited<ReturnType<typeof listTasks>>[number]): TaskListItem {
  return {
    task_id: row.id,
    state: row.state,
    fire_at_utc: row.fire_at_utc.toISOString(),
    fire_at_local: row.wall_time,
    timezone_id: row.timezone_id,
    fold: row.fold,
    resolved_utc_offset_seconds: row.resolved_utc_offset_seconds,
    tzdb_version: row.tzdb_version,
    time_basis: row.time_basis,
    display_version: row.display_version,
    source_approval_id: row.source_approval_id,
    source_invocation_id: row.source_invocation_id,
    schedule_receipt: row.schedule_receipt,
  };
}

export async function listTasksForOwner(
  deps: Deps,
  ownerId: string,
  query: Record<string, string | string[] | undefined>,
): Promise<{ items: TaskListItem[]; next_cursor: string | null }> {
  const parsed = TaskListQuerySchema.safeParse({
    status: query.status,
    cursor: Array.isArray(query.cursor) ? query.cursor[0] : query.cursor,
    limit: Array.isArray(query.limit) ? query.limit[0] : query.limit,
  });
  if (!parsed.success) throw validationError('invalid query');
  let cursor: { fireAt: string; id: string } | undefined;
  if (parsed.data.cursor) {
    const decoded = decodeCursor(parsed.data.cursor);
    if (
      !decoded ||
      typeof decoded.fireAt !== 'string' ||
      typeof decoded.id !== 'string' ||
      !isUuid(decoded.id) ||
      Number.isNaN(Date.parse(decoded.fireAt))
    ) {
      throw validationError('invalid cursor');
    }
    cursor = { fireAt: decoded.fireAt, id: decoded.id };
  }
  const rows = await withClient(requirePool(deps), (client: PoolClient) =>
    listTasks(client, {
      ownerId,
      status: parsed.data.status,
      limit: parsed.data.limit,
      cursor,
    }),
  );
  const hasMore = rows.length > parsed.data.limit;
  const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
  const items = page.map(taskListItem);
  const lastRow = page[page.length - 1] as
    | { id: string; fire_at_utc: Date; fire_at_cursor?: string }
    | undefined;
  const nextCursor =
    hasMore && lastRow
      ? encodeCursor({
          fireAt: lastRow.fire_at_cursor ?? lastRow.fire_at_utc.toISOString(),
          id: lastRow.id,
        })
      : null;
  return { items, next_cursor: nextCursor };
}

export async function getTaskDetail(
  deps: Deps,
  ownerId: string,
  taskId: string,
): Promise<TaskDetail> {
  return withClient(requirePool(deps), async (client: PoolClient) => {
    const lookup = await getTask(client, ownerId, taskId);
    if (!lookup.found) throw notFound('task not found') as ApplicationError;
    if (lookup.forbidden) throw forbidden('task not found') as ApplicationError;
    const row = lookup.row;
    const notifications = await getTaskNotifications(client, ownerId, taskId);
    return {
      ...taskListItem(row),
      kind: row.kind,
      state_version: row.state_version,
      recreated_from: row.recreated_from_task_id,
      created_at: row.created_at.toISOString(),
      notifications,
    };
  });
}

export async function getTaskEvents(
  deps: Deps,
  ownerId: string,
  taskId: string,
  query: Record<string, string | string[] | undefined>,
): Promise<{ items: TaskEventItem[]; next_cursor: string | null }> {
  const parsed = TaskEventsQuerySchema.safeParse({
    cursor: Array.isArray(query.cursor) ? query.cursor[0] : query.cursor,
    limit: Array.isArray(query.limit) ? query.limit[0] : query.limit,
  });
  if (!parsed.success) throw validationError('invalid query');
  let cursor: { recordedAt: string; id: string } | undefined;
  if (parsed.data.cursor) {
    const decoded = decodeCursor(parsed.data.cursor);
    if (
      !decoded ||
      typeof decoded.recordedAt !== 'string' ||
      typeof decoded.id !== 'string' ||
      !isUuid(decoded.id) ||
      Number.isNaN(Date.parse(decoded.recordedAt))
    ) {
      throw validationError('invalid cursor');
    }
    cursor = { recordedAt: decoded.recordedAt, id: decoded.id };
  }
  return withClient(requirePool(deps), async (client: PoolClient) => {
    const lookup = await getTask(client, ownerId, taskId);
    if (!lookup.found) throw notFound('task not found') as ApplicationError;
    if (lookup.forbidden) throw forbidden('task not found') as ApplicationError;
    const rows = await listTaskEvents(client, taskId, parsed.data.limit, cursor);
    const hasMore = rows.length > parsed.data.limit;
    const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    const items: TaskEventItem[] = page.map((row) => ({
      event_id: row.id,
      type: row.type,
      recorded_at_utc: row.recorded_at_utc.toISOString(),
      state_version: row.state_version,
      evidence_ref: row.evidence_ref,
    }));
    const lastRow = page[page.length - 1] as
      | { id: string; recorded_at_utc: Date; recorded_at_cursor?: string }
      | undefined;
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor({
            recordedAt: lastRow.recorded_at_cursor ?? lastRow.recorded_at_utc.toISOString(),
            id: lastRow.id,
          })
        : null;
    return { items, next_cursor: nextCursor };
  });
}
