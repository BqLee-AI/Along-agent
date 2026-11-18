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

/** Frozen task facts for a browsing-day projection; caller owns the client. */
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

export interface ToolBriefTaskRow {
  id: string;
  original_note: string | null;
  wall_time: string;
  timezone_id: string;
  state: string;
}

/** The tool's bounded subset keeps its original IDs and frozen display facts. */
export async function listToolBriefTasks(
  client: PoolClient,
  ownerId: string,
  start: string,
  end: string,
  cardIds?: readonly string[] | null,
): Promise<ToolBriefTaskRow[]> {
  const { rows } = await client.query<ToolBriefTaskRow>(
    `SELECT id, original_note, wall_time, timezone_id, state FROM tasks
     WHERE owner_id = $1 AND state <> 'cancelled'
       AND fire_at_utc >= $2::timestamptz
       AND fire_at_utc < $3::timestamptz
       AND ($4::uuid[] IS NULL OR id = ANY($4::uuid[]))
     ORDER BY fire_at_utc ASC, id ASC LIMIT 50`,
    [ownerId, start, end, cardIds ?? null],
  );
  return rows;
}
