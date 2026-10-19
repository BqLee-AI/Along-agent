// Notifications repository: read-only lookups for the worker send path.
import type { PoolClient } from "pg";

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
