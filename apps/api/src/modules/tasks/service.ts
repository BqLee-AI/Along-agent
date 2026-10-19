import type { Pool, PoolClient } from "pg";
import { withClient } from "../../db/transaction.js";
import {
  decodeCursor,
  encodeCursor,
  forbidden,
  isUuid,
  notFound,
  notReady,
  validationError,
  type HttpError,
} from "../../http/errors.js";
import { getTask, listTaskEvents, listTasks } from "./repository.js";
import { TaskEventsQuerySchema, TaskListQuerySchema } from "./schemas.js";

export interface Deps {
  pool: Pool | null;
}

export interface TaskListItem {
  task_id: string;
  state: string;
  fire_at_utc: string;
  fire_at_local: string;
  timezone_id: string;
  source_approval_id: string | null;
  schedule_receipt: string | null;
}

export interface TaskDetail {
  task_id: string;
  kind: string;
  state: string;
  state_version: number;
  fire_at_utc: string;
  fire_at_local: string;
  timezone_id: string;
  source_approval_id: string | null;
  recreated_from: string | null;
  schedule_receipt: string | null;
  created_at: string;
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
  if (!parsed.success) throw validationError("invalid query");
  let cursor: { fireAt: string; id: string } | undefined;
  if (parsed.data.cursor) {
    const decoded = decodeCursor(parsed.data.cursor);
    if (
      !decoded ||
      typeof decoded.fireAt !== "string" ||
      typeof decoded.id !== "string" ||
      !isUuid(decoded.id) ||
      Number.isNaN(Date.parse(decoded.fireAt))
    ) {
      throw validationError("invalid cursor");
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
  const items: TaskListItem[] = page.map((row) => ({
    task_id: row.id,
    state: row.state,
    fire_at_utc: row.fire_at_utc.toISOString(),
    // fire_at_local is display-only: wall_time as stored (design/03 §5-§7).
    fire_at_local: row.wall_time,
    timezone_id: row.timezone_id,
    source_approval_id: row.source_approval_id,
    schedule_receipt: row.schedule_receipt,
  }));
  const lastRow = page[page.length - 1] as
    | ({ id: string; fire_at_utc: Date; fire_at_cursor?: string })
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
    if (!lookup.found) throw notFound("task not found") as HttpError;
    if (lookup.forbidden) throw forbidden("task not found") as HttpError;
    const row = lookup.row;
    return {
      task_id: row.id,
      kind: row.kind,
      state: row.state,
      state_version: row.state_version,
      fire_at_utc: row.fire_at_utc.toISOString(),
      fire_at_local: row.wall_time,
      timezone_id: row.timezone_id,
      source_approval_id: row.source_approval_id,
      recreated_from: row.recreated_from_task_id,
      schedule_receipt: row.schedule_receipt,
      created_at: row.created_at.toISOString(),
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
  if (!parsed.success) throw validationError("invalid query");
  let cursor: { recordedAt: string; id: string } | undefined;
  if (parsed.data.cursor) {
    const decoded = decodeCursor(parsed.data.cursor);
    if (
      !decoded ||
      typeof decoded.recordedAt !== "string" ||
      typeof decoded.id !== "string" ||
      !isUuid(decoded.id) ||
      Number.isNaN(Date.parse(decoded.recordedAt))
    ) {
      throw validationError("invalid cursor");
    }
    cursor = { recordedAt: decoded.recordedAt, id: decoded.id };
  }
  return withClient(requirePool(deps), async (client: PoolClient) => {
    const lookup = await getTask(client, ownerId, taskId);
    if (!lookup.found) throw notFound("task not found") as HttpError;
    if (lookup.forbidden) throw forbidden("task not found") as HttpError;
    const rows = await listTaskEvents(
      client,
      taskId,
      parsed.data.limit,
      cursor,
    );
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
      | ({ id: string; recorded_at_utc: Date; recorded_at_cursor?: string })
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
