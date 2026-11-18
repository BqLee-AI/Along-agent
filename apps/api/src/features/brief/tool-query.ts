import type { PoolClient } from 'pg';
import { listToolBriefTasks } from '../tasks/public.js';
import { readUserPreferences } from '../identity/public.js';
import type { TimeContext } from '../time/public.js';
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
  const rows = await listToolBriefTasks(client, ownerId, start, end, input.card_ids);
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
