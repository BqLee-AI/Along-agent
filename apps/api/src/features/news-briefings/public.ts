import type { Pool, PoolClient } from 'pg';
import { notFound } from '../../platform/errors.js';
import type { collectNews } from './content.js';

type Items = Awaited<ReturnType<typeof collectNews>>['items'];

export async function readEdition(db: Pool | PoolClient, owner: string, id: string) {
  const {
    rows: [row],
  } = await db.query<{
    id: string;
    local_date: string;
    coverage: 'complete' | 'partial' | 'failed';
    delivery: 'pending' | 'sending' | 'accepted' | 'failed' | 'unknown' | 'skipped';
    items: Items;
  }>(
    `SELECT e.id,e.local_date::text,e.coverage,e.items,COALESCE(d.status,'pending') AS delivery
      FROM news_editions e LEFT JOIN news_deliveries d ON d.edition_id=e.id
      WHERE e.owner_id=$1 AND e.id=$2 AND e.coverage IS NOT NULL`,
    [owner, id],
  );
  if (!row) throw notFound('news edition not found');
  return row;
}
