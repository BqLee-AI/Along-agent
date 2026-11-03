import type { PoolClient } from 'pg';

// approvals repository: raw SQL reads. GET routes MUST NOT write.
// Effective-status projection: a row stored as `pending` whose expires_at or
// fire_at_utc has passed is *projected* as `expired` (read-only; persistence
// of the expiry happens on confirm/reject paths in PR2).

interface ApprovalRowFields {
  id: string;
  owner_id: string;
  conversation_id: string | null;
  original_text: string | null;
  fire_at_utc: Date;
  wall_time: string;
  timezone_id: string;
  fold: number;
  resolved_utc_offset_seconds: number;
  occurrence: string;
  presentation_hash: string;
  presentation_version: string;
  state: string;
  created_at: Date;
  expires_at: Date;
  consumed_task_id: string | null;
  supersedes_approval_id: string | null;
  // 0011 (#9): create_task (default, pre-0011 rows) or cancel_task.
  target_task_id: string | null;
  expected_state_version: number | null;
}

// Create approvals always retain their wall-time rules; only cancellation of
// a UTC elapsed task can carry a null tzdb version.
export type ApprovalRow = ApprovalRowFields &
  (
    | { kind: 'create_task'; tzdb_version: string }
    | { kind: 'cancel_task'; tzdb_version: string | null }
  );

export type EffectiveStatus = 'pending' | 'expired';

export function effectiveStatus(
  row: Pick<ApprovalRow, 'state' | 'expires_at' | 'fire_at_utc'>,
  now: Date,
): string {
  if (row.state !== 'pending') return row.state;
  if (row.expires_at.getTime() <= now.getTime()) return 'expired';
  if (row.fire_at_utc.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

export interface ApprovalListFilter {
  ownerId: string;
  status: string; // pending|consumed|rejected|expired|superseded|all
  limit: number;
  cursor?: { createdAt: string; id: string };
  now: Date;
}

export async function listApprovals(
  client: PoolClient,
  filter: ApprovalListFilter,
): Promise<ApprovalRow[]> {
  const params: unknown[] = [filter.ownerId];
  const where: string[] = ['owner_id = $1'];
  if (filter.status !== 'all') {
    if (filter.status === 'expired') {
      params.push(filter.now.toISOString());
      where.push(
        `(state = 'expired' OR (state = 'pending' AND (expires_at <= $${params.length} OR fire_at_utc <= $${params.length})))`,
      );
    } else if (filter.status === 'pending') {
      params.push(filter.now.toISOString());
      where.push(
        `(state = 'pending' AND expires_at > $${params.length} AND fire_at_utc > $${params.length})`,
      );
    } else {
      params.push(filter.status);
      where.push(`state = $${params.length}`);
    }
  }
  if (filter.cursor) {
    params.push(filter.cursor.createdAt, filter.cursor.id);
    where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
  }
  params.push(filter.limit + 1);
  const { rows } = await client.query<ApprovalRow & { created_at_cursor: string }>(
    `SELECT *, to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at_cursor ` +
      `FROM approvals WHERE ${where.join(' AND ')} ` +
      `ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params as never[],
  );
  for (const row of rows) {
    row.created_at = new Date(row.created_at_cursor);
  }
  return rows;
}
export type ApprovalLookup =
  | { found: false }
  | { found: true; forbidden: true }
  | { found: true; forbidden: false; row: ApprovalRow };

export async function getApproval(
  client: PoolClient,
  ownerId: string,
  approvalId: string,
): Promise<ApprovalLookup> {
  const { rows } = await client.query<ApprovalRow>('SELECT * FROM approvals WHERE id = $1', [
    approvalId,
  ]);
  const row = rows[0];
  if (!row) return { found: false };
  if (row.owner_id !== ownerId) return { found: true, forbidden: true };
  return { found: true, forbidden: false, row };
}

export type ApprovalReadRow = ApprovalRow & {
  effective_now: Date;
  successor_approval_id: string | null;
};

// One statement snapshot binds the stored status, result and successor together.
// The clock is captured once for the public projection; no expiry is persisted.
export async function readApprovalFacts(
  client: PoolClient,
  approvalId: string,
  now?: Date,
): Promise<ApprovalReadRow | null> {
  const { rows } = await client.query<ApprovalReadRow>(
    `SELECT approval.*,
       COALESCE($2::timestamptz, clock_timestamp()) AS effective_now,
       (SELECT successor.id FROM approvals successor
        WHERE successor.supersedes_approval_id = approval.id
          AND successor.owner_id = approval.owner_id) AS successor_approval_id
     FROM approvals approval WHERE approval.id = $1`,
    [approvalId, now?.toISOString() ?? null],
  );
  return rows[0] ?? null;
}

export async function findSuccessorId(
  client: PoolClient,
  approvalId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM approvals WHERE supersedes_approval_id = $1',
    [approvalId],
  );
  return rows[0]?.id ?? null;
}
// ---- PR2 confirm/reject writes (single-transaction only) ----
// Row lock: the caller's transaction holds this row until COMMIT/ROLLBACK,
// so concurrent confirms serialize here (concurrency main defense).
export async function getApprovalForUpdate(
  client: PoolClient,
  approvalId: string,
): Promise<ApprovalRow | null> {
  const { rows } = await client.query<ApprovalRow>(
    'SELECT * FROM approvals WHERE id = $1 FOR UPDATE',
    [approvalId],
  );
  return rows[0] ?? null;
}

// Caller must hold the target lock and have checked owner. Return a normal
// transaction outcome on expiry, then raise 410 only after COMMIT.
export async function persistExpiredIfDue(
  client: PoolClient,
  approvalId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE approvals SET state = 'expired'
     WHERE id = $1 AND state = 'pending'
       AND (expires_at <= clock_timestamp() OR fire_at_utc <= clock_timestamp())`,
    [approvalId],
  );
  return (rowCount ?? 0) > 0;
}

// Read-only DB-clock expiry probe (for tests / diagnostics).
export async function isExpiredByDbClock(client: PoolClient, approvalId: string): Promise<boolean> {
  const { rows } = await client.query<{ expired: boolean }>(
    `SELECT (expires_at <= clock_timestamp() OR fire_at_utc <= clock_timestamp()) AS expired
     FROM approvals WHERE id = $1`,
    [approvalId],
  );
  return rows[0]?.expired ?? false;
}

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

export async function markConsumed(
  client: PoolClient,
  approvalId: string,
  taskId: string | null,
): Promise<void> {
  await client.query(
    "UPDATE approvals SET state = 'consumed', consumed_task_id = $2 WHERE id = $1",
    [approvalId, taskId],
  );
}

export async function markRejected(client: PoolClient, approvalId: string): Promise<void> {
  await client.query("UPDATE approvals SET state = 'rejected' WHERE id = $1", [approvalId]);
}
