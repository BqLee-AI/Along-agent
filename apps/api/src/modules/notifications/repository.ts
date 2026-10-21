// Notifications repository: lookups for task details and the worker send path.
import type { PoolClient } from 'pg';

export interface NoticeLookup {
  id: string;
  status: string;
  sentAt: Date | null;
}

export async function findNoticeByKey(
  client: PoolClient,
  idempotencyKey: string,
): Promise<NoticeLookup | null> {
  const { rows } = await client.query<NoticeLookup>(
    `SELECT id, status, sent_at AS "sentAt" FROM notifications
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return rows[0] ?? null;
}

export interface TaskNoticeRow {
  id: string;
  title: string;
  body: string;
  status: 'pending' | 'sent' | 'failed';
  sent_at: Date | null;
}

export async function listTaskNotices(
  client: PoolClient,
  ownerId: string,
  taskId: string,
): Promise<TaskNoticeRow[]> {
  const { rows } = await client.query<TaskNoticeRow>(
    `SELECT id, title, body, status, sent_at FROM notifications
     WHERE owner_id = $1 AND task_id = $2 ORDER BY created_at, id`,
    [ownerId, taskId],
  );
  return rows;
}
