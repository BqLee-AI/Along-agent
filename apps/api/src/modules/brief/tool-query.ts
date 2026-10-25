import type { PoolClient } from 'pg';

export interface ToolBriefCards {
  brief_id: string;
  date: string;
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
): Promise<ToolBriefCards> {
  const { rows } = await client.query<{
    id: string;
    original_note: string | null;
    wall_time: string;
    timezone_id: string;
    state: string;
  }>(
    `SELECT id, original_note, wall_time, timezone_id, state FROM tasks
     WHERE owner_id = $1 AND wall_time LIKE $2 || '%' AND state <> 'cancelled'
       AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
     ORDER BY wall_time ASC LIMIT 50`,
    [ownerId, input.date, input.card_ids ?? null],
  );
  return {
    brief_id: `brief:${input.date}`,
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
