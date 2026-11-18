import type { PoolClient } from 'pg';

export interface BriefApprovalRow {
  id: string;
  kind: 'create_task' | 'cancel_task';
  original_text: string | null;
  fire_at_utc: Date;
  wall_time: string;
  timezone_id: string;
  expires_at: Date;
}

/** Pending, future reminder approvals, with no expiry mutation or task effects. */
export async function listBriefApprovals(
  client: PoolClient,
  ownerId: string,
  start: string,
  end: string,
  now: Date,
): Promise<BriefApprovalRow[]> {
  const { rows } = await client.query<BriefApprovalRow>(
    `SELECT id, kind, original_text, fire_at_utc, wall_time, timezone_id, expires_at
       FROM approvals
      WHERE owner_id = $1
        AND state = 'pending'
        AND expires_at > $4
        AND fire_at_utc > $4
        AND fire_at_utc >= $2::timestamptz
        AND fire_at_utc < $3::timestamptz
      ORDER BY fire_at_utc ASC, id ASC`,
    [ownerId, start, end, now.toISOString()],
  );
  return rows;
}
