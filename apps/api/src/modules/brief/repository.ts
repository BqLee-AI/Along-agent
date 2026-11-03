// Brief read projection (issue #10). [跨模块读] tasks + approvals by
// owner and the browsing timezone's UTC day interval. Display facts remain frozen.
// Reads only: the brief has no write path and no snapshot table.
import type { PoolClient } from 'pg';
import type { ElapsedTimeBasis } from '@along/contracts';

export interface BriefTaskRow {
  id: string;
  state: string;
  fire_at_utc: Date;
  wall_time: string;
  timezone_id: string;
  original_note: string | null;
  time_basis: ElapsedTimeBasis | null;
  display_version: 'elapsed/1' | null;
}

export interface BriefApprovalRow {
  id: string;
  kind: 'create_task' | 'cancel_task';
  original_text: string | null;
  fire_at_utc: Date;
  wall_time: string;
  timezone_id: string;
  expires_at: Date;
}

export async function listBriefTasks(
  client: PoolClient,
  ownerId: string,
  start: string,
  end: string,
): Promise<BriefTaskRow[]> {
  const { rows } = await client.query<BriefTaskRow>(
    `SELECT id, state, fire_at_utc, wall_time, timezone_id, original_note, time_basis, display_version
       FROM tasks
      WHERE owner_id = $1
        AND state <> 'cancelled'
        AND fire_at_utc >= $2::timestamptz
        AND fire_at_utc < $3::timestamptz
      ORDER BY fire_at_utc ASC, id ASC`,
    [ownerId, start, end],
  );
  return rows;
}

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
