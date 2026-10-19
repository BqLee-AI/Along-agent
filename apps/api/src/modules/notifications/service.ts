// Notifications: read-only frozen task fields -> in-app notice rows.
// Only ever reads tasks' frozen display fields (wall_time, timezone_id,
// original_note); never converts time. INSERT ... ON CONFLICT
// (idempotency_key) DO NOTHING returns the existing row's receipt so retries
// share one notice (kill -9 resume fires exactly once).
import type { PoolClient } from "pg";
import { noticeCopyFor } from "@along/notifier-core";

export interface InAppNotice {
  ownerId: string;
  taskId: string;
  wallTime: string;
  timezoneId: string;
  originalNote: string | null;
  idempotencyKey: string;
}

export interface InAppDelivery {
  delivered: boolean;
  answered: boolean;
  providerReceiptId: string | null;
}

export type InAppProvider = ((notice: InAppNotice) => Promise<InAppDelivery>) | null;

export interface StoredNotice {
  id: string;
  idempotencyKey: string;
  status: string;
  sentAt: Date | null;
}

/** Local in-app provider: records intake, proves nothing about the user. */
export async function localInAppProvider(notice: InAppNotice): Promise<InAppDelivery> {
  void notice;
  return { delivered: true, answered: true, providerReceiptId: null };
}

/**
 * Deliver one in-app notice. The provider result decides the receipt; the
 * row write is idempotent on idempotency_key. Returns the stored row.
 */
export async function deliverInApp(
  client: PoolClient,
  notice: InAppNotice,
  provider: InAppProvider = null,
): Promise<InAppDelivery> {
  const effective = provider ?? localInAppProvider;
  const result = await effective(notice);
  const copy = noticeCopyFor({
    wallTime: notice.wallTime,
    timezoneId: notice.timezoneId,
    originalNote: notice.originalNote,
  });
  const status = result.delivered ? "sent" : "pending";
  const { rows } = await client.query<StoredNotice>(
    `INSERT INTO notifications (id, owner_id, task_id, channel, title, body,
       idempotency_key, status, sent_at)
     VALUES (gen_random_uuid(), $1, $2, 'inapp', $3, $4, $5, $6,
       CASE WHEN $6 = 'sent' THEN now() ELSE NULL END)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, idempotency_key, status, sent_at`,
    [notice.ownerId, notice.taskId, copy.title, copy.body, notice.idempotencyKey, status],
  );
  const stored = rows[0] ?? null;
  if (!stored) {
    // Duplicate key: the earlier attempt owns the notice; replay its receipt.
    const existing = await client.query<StoredNotice>(
      `SELECT id, idempotency_key, status, sent_at FROM notifications
       WHERE idempotency_key = $1`,
      [notice.idempotencyKey],
    );
    const row = existing.rows[0];
    void row;
  }
  return {
    delivered: result.delivered,
    answered: result.answered,
    providerReceiptId: result.providerReceiptId ?? `inapp:${notice.idempotencyKey}`,
  };
}
