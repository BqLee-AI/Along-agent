import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { isActiveOwner, readUserPreferences } from '../identity/public.js';
import type { TimeContext } from '../time/public.js';
import { collectNews } from './content.js';
import { dailySlot } from './schedule.js';
import { sendWechat } from './wechat-provider.js';

interface Claim {
  id: string;
  claim_id: string;
  topics: string[];
  region: string | null;
  cutoff_at: Date;
  coverage: 'complete' | 'partial' | 'failed' | null;
}

type News = Awaited<ReturnType<typeof collectNews>>;

type SlotResolver = typeof dailySlot;

async function claimDay(
  client: PoolClient,
  ownerId: string,
  time: TimeContext,
  resolveSlot: SlotResolver,
) {
  if (!(await isActiveOwner(client, ownerId, { lock: 'share' }))) return null;
  const { timezone_id: timezone } = await readUserPreferences(client, ownerId);
  if (!timezone) return null;
  const {
    rows: [sub],
  } = await client.query<{
    binding_id: string;
    topics: string[];
    region: string | null;
    enabled_at: Date;
    clock: Date;
  }>(
    `SELECT binding_id,topics,region,enabled_at,clock_timestamp() AS clock
      FROM news_subscriptions WHERE owner_id=$1 AND enabled FOR UPDATE`,
    [ownerId],
  );
  if (!sub) return null;
  const slot = resolveSlot(sub.clock, timezone, time);
  if (!slot || slot.cutoff > sub.clock || slot.cutoff < sub.enabled_at) return null;
  const token = randomUUID();
  const {
    rows: [edition],
  } = await client.query<Claim>(
    `INSERT INTO news_editions (owner_id,binding_id,local_date,timezone_id,cutoff_at,topics,
        region,claim_id,lease_until)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '5 minutes'
     WHERE EXISTS (SELECT FROM news_wechat_bindings
       WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL)
     ON CONFLICT (owner_id,local_date) DO UPDATE SET claim_id=$8,
       lease_until=clock_timestamp()+interval '5 minutes'
     WHERE news_editions.lease_until<=clock_timestamp()
       AND NOT EXISTS (SELECT FROM news_deliveries WHERE edition_id=news_editions.id)
     RETURNING id,claim_id,topics,region,cutoff_at,coverage`,
    [ownerId, sub.binding_id, slot.date, timezone, slot.cutoff, sub.topics, sub.region, token],
  );
  return edition ?? null;
}

async function publish(pool: Pool, claim: Claim, news: News) {
  await pool.query(
    `UPDATE news_editions SET coverage=$3,items=$4
     WHERE id=$1 AND claim_id=$2 AND lease_until>clock_timestamp() AND coverage IS NULL`,
    [claim.id, claim.claim_id, news.coverage, JSON.stringify(news.items)],
  );
}

async function permit(client: PoolClient, ownerId: string, claim: Claim) {
  const active = await isActiveOwner(client, ownerId, { lock: 'share' });
  const {
    rows: [subscription],
  } = await client.query<{ binding_id: string; enabled: boolean }>(
    'SELECT binding_id,enabled FROM news_subscriptions WHERE owner_id=$1 FOR UPDATE',
    [ownerId],
  );
  const {
    rows: [edition],
  } = await client.query<{
    binding_id: string;
    date: string;
    coverage: News['coverage'];
    items: News['items'];
  }>(
    `SELECT binding_id,local_date::text AS date,coverage,items FROM news_editions
      WHERE id=$1 AND claim_id=$2 AND lease_until>clock_timestamp() AND coverage IS NOT NULL
      FOR UPDATE`,
    [claim.id, claim.claim_id],
  );
  if (!edition) return null;
  const binding =
    active && subscription?.enabled && subscription.binding_id === edition.binding_id
      ? (
          await client.query<{
            id: string;
            platform_user_id: string;
            credential_ciphertext: string;
          }>(
            `SELECT id,platform_user_id,credential_ciphertext FROM news_wechat_bindings
         WHERE owner_id=$1 AND id=$2 AND revoked_at IS NULL FOR SHARE`,
            [ownerId, edition.binding_id],
          )
        ).rows[0]
      : null;
  const send = binding && edition.coverage !== 'failed';
  const reserved = await client.query(
    `INSERT INTO news_deliveries (edition_id,status) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [claim.id, send ? 'sending' : 'skipped'],
  );
  return reserved.rowCount && send ? { edition, binding } : null;
}

function formatEdition(edition: {
  date: string;
  coverage: News['coverage'];
  items: News['items'];
}) {
  const lines = [`Along 新闻简报 · ${edition.date}`];
  if (edition.coverage === 'partial') lines.push('部分新闻来源覆盖不完整');
  for (const section of ['topic', 'local'] as const) {
    const items = edition.items.filter((item) => item.section === section);
    if (!items.length) continue;
    lines.push('', section === 'topic' ? '关注主题' : '本地新闻');
    for (const item of items) {
      lines.push(item.summary);
      for (const source of item.sources) lines.push(`${source.name} ${source.url}`);
    }
  }
  if (!edition.items.length) lines.push('', '本期暂无符合订阅偏好的新闻。');
  return lines.join('\n');
}

export async function runNewsTick(
  pool: Pool,
  time: TimeContext,
  { resolveSlot = dailySlot, collect = collectNews, send = sendWechat } = {},
) {
  await pool.query(`UPDATE news_deliveries SET status='unknown'
    WHERE status='sending' AND permitted_at < clock_timestamp()-interval '5 minutes'`);
  const { rows } = await pool.query<{ owner_id: string }>(
    `SELECT owner_id FROM news_subscriptions WHERE enabled ORDER BY owner_id`,
  );
  for (const { owner_id: ownerId } of rows) {
    const claim = await withTransaction(pool, (client) =>
      claimDay(client, ownerId, time, resolveSlot),
    );
    if (!claim) continue;
    if (claim.coverage === null) {
      const news = await collect({
        topics: claim.topics,
        region: claim.region,
        cutoff: claim.cutoff_at,
      });
      await publish(pool, claim, news);
    }
    const reserved = await withTransaction(pool, (client) => permit(client, ownerId, claim));
    if (!reserved) continue;
    const { edition, binding } = reserved;
    const { status } = await send(
      binding.credential_ciphertext,
      ownerId,
      binding.id,
      binding.platform_user_id,
      formatEdition(edition),
    );
    await pool.query(
      `UPDATE news_deliveries SET status=$2 WHERE edition_id=$1 AND status='sending'`,
      [claim.id, status],
    );
  }
}
