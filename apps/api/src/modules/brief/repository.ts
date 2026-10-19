// Brief read projection (issue #10). [跨模块读] tasks + approvals by
// owner and frozen local date. Reads only: the brief has no write path and no
// snapshot table (S0 #14: v0 briefs are a deterministic projection).
import type { PoolClient } from "pg";

export interface BriefTaskRow {
  id: string;
  state: string;
  fire_at_utc: Date;
  wall_time: string;
  timezone_id: string;
  original_note: string | null;
}

export interface BriefApprovalRow {
  id: string;
  kind: "create_task" | "cancel_task";
  original_text: string | null;
  fire_at_utc: Date;
  wall_time: string;
  timezone_id: string;
  expires_at: Date;
}

export async function listBriefTasks(
  client: PoolClient,
  ownerId: string,
  date: string,
  timezoneId: string,
): Promise<BriefTaskRow[]> {
  const { rows } = await client.query<BriefTaskRow>(
    `SELECT id, state, fire_at_utc, wall_time, timezone_id, original_note
       FROM tasks
      WHERE owner_id = $1
        AND state <> 'cancelled'
        AND timezone_id = $2
        AND wall_time LIKE $3 || '%'
      ORDER BY fire_at_utc ASC, id ASC`,
    [ownerId, timezoneId, date],
  );
  return rows;
}

export async function listBriefApprovals(
  client: PoolClient,
  ownerId: string,
  date: string,
  timezoneId: string,
  now: Date,
): Promise<BriefApprovalRow[]> {
  const { rows } = await client.query<BriefApprovalRow>(
    `SELECT id, kind, original_text, fire_at_utc, wall_time, timezone_id, expires_at
       FROM approvals
      WHERE owner_id = $1
        AND state = 'pending'
        AND expires_at > $4
        AND fire_at_utc > $4
        AND timezone_id = $2
        AND wall_time LIKE $3 || '%'
      ORDER BY fire_at_utc ASC, id ASC`,
    [ownerId, timezoneId, date, now.toISOString()],
  );
  return rows;
}
