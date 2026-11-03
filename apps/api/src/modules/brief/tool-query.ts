import type { PoolClient } from 'pg';
import { readUserPreferences } from '../identity/preferences.js';
import type { TimeContext } from '../time/context.js';
import { briefDayRange } from './day-range.js';

export interface ToolBriefCards {
  brief_id: string;
  date: string;
  timezone_id: string;
  cards: {
    card_id: string;
    kind: string;
    title: string;
    body_text: string;
    source_refs: string[];
    presentation_version: string;
  }[];
}

// Public tool projection, not the HTTP brief DTO: keep its raw task card IDs,
// titles and wall-time display intact within the invocation transaction.
export async function readToolBriefCards(
  client: PoolClient,
  ownerId: string,
  input: { date: string; card_ids?: readonly string[] | null },
  timeContext?: TimeContext,
): Promise<ToolBriefCards> {
  const { timezone_id: timezoneId } = await readUserPreferences(client, ownerId);
  const { start, end } = briefDayRange(input.date, timezoneId ?? 'UTC', new Date(), timeContext);
  const { rows } = await client.query<{
    id: string;
    original_note: string | null;
    wall_time: string;
    timezone_id: string;
    state: string;
  }>(
    `SELECT id, original_note, wall_time, timezone_id, state FROM tasks
     WHERE owner_id = $1 AND state <> 'cancelled'
       AND fire_at_utc >= $2::timestamptz
       AND fire_at_utc < $3::timestamptz
       AND ($4::uuid[] IS NULL OR id = ANY($4::uuid[]))
     ORDER BY fire_at_utc ASC, id ASC LIMIT 50`,
    [ownerId, start, end, input.card_ids ?? null],
  );
  return {
    brief_id: `brief:${input.date}`,
    timezone_id: timezoneId ?? 'UTC',
    date: input.date,
    cards: rows.map((row) => ({
      card_id: row.id,
      kind: 'task',
      title: (row.original_note ?? '').slice(0, 30),
      body_text: `${row.wall_time}（${row.timezone_id}）`,
      source_refs: [row.id],
      presentation_version: 'v1',
    })),
  };
}
