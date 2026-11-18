// Notifications owns intake writes and receipt evidence queries.
import type { PoolClient } from 'pg';

export interface ReceivedNoticeRow {
  id: string;
  fireAtUtc: Date;
  expectedStateVersion: number;
}

export async function findReceivedNotice(
  client: PoolClient,
  ownerId: string,
  taskId: string,
  idempotencyKey: string,
): Promise<ReceivedNoticeRow | null> {
  const { rows } = await client.query<ReceivedNoticeRow>(
    `SELECT id, fire_at_utc AS "fireAtUtc",
       expected_state_version AS "expectedStateVersion"
     FROM notifications
     WHERE owner_id = $1 AND task_id = $2 AND idempotency_key = $3
       AND channel = 'inapp' AND status = 'sent' AND sent_at IS NOT NULL
       AND fire_at_utc IS NOT NULL AND expected_state_version > 0`,
    [ownerId, taskId, idempotencyKey],
  );
  return rows[0] ?? null;
}

export interface ReceivedNoticeInput {
  ownerId: string;
  taskId: string;
  idempotencyKey: string;
  fireAtUtc: string;
  expectedStateVersion: number;
  title: string;
  body: string;
}

/** A conflicting key is reusable only as the exact same committed intake. */
export async function insertReceivedNotice(
  client: PoolClient,
  input: ReceivedNoticeInput,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO notifications (id, owner_id, task_id, channel, title, body,
       idempotency_key, status, sent_at, fire_at_utc, expected_state_version)
     VALUES (gen_random_uuid(), $1, $2, 'inapp', $3, $4, $5, 'sent', now(), $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.ownerId,
      input.taskId,
      input.title,
      input.body,
      input.idempotencyKey,
      input.fireAtUtc,
      input.expectedStateVersion,
    ],
  );
  if (rows[0]) return rows[0].id;
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM notifications
     WHERE owner_id = $1 AND task_id = $2 AND idempotency_key = $3
       AND fire_at_utc = $4::timestamptz AND expected_state_version = $5
       AND channel = 'inapp' AND status = 'sent' AND sent_at IS NOT NULL`,
    [
      input.ownerId,
      input.taskId,
      input.idempotencyKey,
      input.fireAtUtc,
      input.expectedStateVersion,
    ],
  );
  return existing.rows[0]?.id ?? null;
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
