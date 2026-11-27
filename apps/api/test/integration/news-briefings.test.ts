import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readEdition } from '../../src/features/news-briefings/public.js';
import { dailySlot } from '../../src/features/news-briefings/schedule.js';
import { runNewsTick } from '../../src/features/news-briefings/worker.js';
import { loadTimeContext } from '../../src/features/time/public.js';
import { createIntegrationDatabase, databaseUrl, seedAdmittedSession } from './setup.js';

const time = loadTimeContext('fixture-v1');

describe('daily news schedule', () => {
  it('uses local date and the new UTC offset after a DST transition', () => {
    expect(dailySlot(new Date('2026-03-07T13:30:00Z'), 'America/New_York', time)).toEqual({
      date: '2026-03-07',
      cutoff: new Date('2026-03-07T13:00:00Z'),
    });
    expect(dailySlot(new Date('2026-03-08T12:30:00Z'), 'America/New_York', time)).toEqual({
      date: '2026-03-08',
      cutoff: new Date('2026-03-08T12:00:00Z'),
    });
    expect(dailySlot(new Date('2026-03-08T04:30:00Z'), 'America/New_York', time)?.date).toBe(
      '2026-03-07',
    );
  });
});

const withDatabase = databaseUrl ? describe : describe.skip;
withDatabase('news delivery on PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof createIntegrationDatabase>>;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  it('claims once, retains the published issue, and does not replay an uncertain send', async () => {
    const owner = (await seedAdmittedSession(db.pool)).userId;
    const other = (await seedAdmittedSession(db.pool)).userId;
    const binding = randomUUID();
    await db.pool.query("UPDATE users SET timezone_id='Asia/Shanghai' WHERE id=$1", [owner]);
    await db.pool.query(
      `INSERT INTO news_wechat_bindings VALUES ($1,$2,$3,'test-credential',NULL)`,
      [binding, owner, 'test-platform-user'],
    );
    await db.pool.query(
      `INSERT INTO news_subscriptions VALUES ($1,$2,ARRAY['科技'],NULL,true,'2026-03-07')`,
      [owner, binding],
    );
    const messages: string[] = [];
    const article = {
      section: 'topic' as const,
      summary: '科技新闻摘录',
      sources: [{ name: '来源', url: 'https://example.org/article' }],
    };
    const dependencies = {
      resolveSlot: () => ({ date: '2026-03-08', cutoff: new Date('2026-03-08T00:00:00Z') }),
      collect: async () => ({ coverage: 'complete' as const, items: [article] }),
      send: async (
        _secret: string,
        _owner: string,
        _id: string,
        _recipient: string,
        text: string,
      ) => {
        messages.push(text);
        return { status: 'unknown' as const };
      },
    };
    await Promise.all([
      runNewsTick(db.pool, time, dependencies),
      runNewsTick(db.pool, time, dependencies),
    ]);
    await db.pool.query("UPDATE news_editions SET lease_until='2026-03-08' WHERE owner_id=$1", [
      owner,
    ]);
    await runNewsTick(db.pool, time, dependencies);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(article.sources[0]!.url);
    const { rows } = await db.pool.query<{ id: string }>(
      'SELECT id FROM news_editions WHERE owner_id=$1',
      [owner],
    );
    expect(rows).toHaveLength(1);
    const id = rows[0]!.id;
    expect(await readEdition(db.pool, owner, id)).toMatchObject({
      items: [article],
      delivery: 'unknown',
    });
    await expect(readEdition(db.pool, other, id)).rejects.toThrow('news edition not found');
  });

  it('retains the edition without sending when the binding is revoked during collection', async () => {
    const owner = (await seedAdmittedSession(db.pool)).userId;
    const binding = randomUUID();
    await db.pool.query("UPDATE users SET timezone_id='Asia/Shanghai' WHERE id=$1", [owner]);
    await db.pool.query(
      `INSERT INTO news_wechat_bindings VALUES ($1,$2,'revoked-recipient','test-credential',NULL)`,
      [binding, owner],
    );
    await db.pool.query(
      `INSERT INTO news_subscriptions VALUES ($1,$2,ARRAY['科技'],NULL,true,'2026-03-07')`,
      [owner, binding],
    );
    await runNewsTick(db.pool, time, {
      resolveSlot: () => ({ date: '2026-03-08', cutoff: new Date('2026-03-08T00:00:00Z') }),
      collect: async () => {
        await db.pool.query(
          'UPDATE news_wechat_bindings SET revoked_at=clock_timestamp() WHERE id=$1',
          [binding],
        );
        return { coverage: 'complete', items: [] };
      },
      send: async () => {
        throw new Error('revoked binding received a send permit');
      },
    });
    const { rows } = await db.pool.query<{ id: string }>(
      'SELECT id FROM news_editions WHERE owner_id=$1',
      [owner],
    );
    expect(rows).toHaveLength(1);
    expect(await readEdition(db.pool, owner, rows[0]!.id)).toMatchObject({
      coverage: 'complete',
      items: [],
      delivery: 'skipped',
    });
  });
});
