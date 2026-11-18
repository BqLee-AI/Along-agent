import { expectApplicationRejection } from '../helpers/application-error.js';
// Issue #10: GET /brief deterministic projection.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { handleRequest } from '../helpers/http-app.js';
import { getBrief } from '../../src/features/brief/service.js';
import { readToolBriefCards } from '../../src/features/brief/tool-query.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import { BriefResponseSchema } from '../../src/features/brief/schemas.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedApproval,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const timeContext = loadTimeContext('fixture-v1');
const NOW = new Date('2026-10-17T00:00:00Z');

async function seedTask(
  pool: Pool,
  ownerId: string,
  args: {
    state: string;
    fireAt: string;
    wallTime: string;
    note: string;
    timezoneId?: string;
  },
): Promise<string> {
  const id = randomUUID();
  // New rows require exactly one real creation source; a consumed approval
  // never appears in the pending-approval brief projection.
  const source = await seedApproval(pool, { ownerId, state: 'consumed' });
  await pool.query(
    `INSERT INTO tasks (id, owner_id, state, fire_at_utc, wall_time, timezone_id,
       fold, resolved_utc_offset_seconds, tzdb_version, original_note, source_approval_id)
     VALUES ($1,$2,$3,$4,$5,$6,0,28800,'fixture-v1',$7,$8)`,
    [
      id,
      ownerId,
      args.state,
      args.fireAt,
      args.wallTime,
      args.timezoneId ?? 'Asia/Shanghai',
      args.note,
      source.id,
    ],
  );
  return id;
}

async function seedPendingApproval(
  pool: Pool,
  ownerId: string,
  args: { fireAt: string; wallTime: string; text: string; kind?: string },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO approvals (id, owner_id, original_text, fire_at_utc, wall_time,
       timezone_id, fold, resolved_utc_offset_seconds, tzdb_version, occurrence,
       presentation_hash, presentation_version, state, expires_at, kind,
       target_task_id, expected_state_version)
     VALUES ($1,$2,$3,$4,$5,'Asia/Shanghai',0,28800,'fixture-v1','single',
       'ph-test','v1','pending','2026-10-18T00:00:00Z','create_task',NULL,NULL)`,
    [id, ownerId, args.text, args.fireAt, args.wallTime],
  );
  return id;
}

function fakePair(method: string, url: string) {
  const req = { method, url, headers: {} } as unknown as IncomingMessage;
  const res = {
    status: 0,
    resHeaders: {} as Record<string, string>,
    payload: '',
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status;
      res.resHeaders = headers;
    },
    end(body: string) {
      res.payload = body;
    },
  } as unknown as ServerResponse & {
    status: number;
    resHeaders: Record<string, string>;
    payload: string;
  };
  return { req, res, body: () => JSON.parse(res.payload) as Record<string, unknown> };
}

maybe('brief', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });

  it('assembles the confirmed-timezone date deterministically from tasks + approvals', async () => {
    const ownerId = randomUUID();
    await seedTask(pool, ownerId, {
      state: 'scheduled',
      fireAt: '2026-10-17T01:20:00Z',
      wallTime: '2026-10-17 09:20',
      note: '喝水',
    });
    await seedTask(pool, ownerId, {
      state: 'fired',
      fireAt: '2026-10-17T00:00:00Z',
      wallTime: '2026-10-17 08:00',
      note: '吃药',
    });
    await seedTask(pool, ownerId, {
      state: 'cancelled',
      fireAt: '2026-10-17T03:00:00Z',
      wallTime: '2026-10-17 11:00',
      note: '已取消',
    });
    await seedTask(pool, ownerId, {
      state: 'scheduled',
      fireAt: '2026-10-18T01:20:00Z',
      wallTime: '2026-10-18 09:20',
      note: '明天',
    });
    const approvalId = await seedPendingApproval(pool, ownerId, {
      fireAt: '2026-10-17T02:00:00Z',
      wallTime: '2026-10-17 10:00',
      text: '明天 10:00 散步',
    });

    const deps = { pool, tzdbVersion: 'fixture-v1', timeContext, now: () => NOW };
    const brief = await getBrief(deps, ownerId, 'Asia/Shanghai', {}, 'req-test');
    expect(BriefResponseSchema.parse(brief)).toEqual(brief);
    expect(brief.date).toBe('2026-10-17');
    expect(brief.timezone_id).toBe('Asia/Shanghai');
    expect(brief.summary).toEqual({ pending_count: 1, fired_count: 1 });
    expect(brief.cards.map((card) => card.kind)).toEqual(['task', 'task', 'approval']);
    expect(brief.cards[0]).toMatchObject({
      kind: 'task',
      title: '吃药',
      status: 'fired',
      fire_at_local: '2026-10-17 08:00',
    });
    expect(brief.cards[1]).toMatchObject({
      kind: 'task',
      title: '喝水',
      status: 'scheduled',
      fire_at_local: '2026-10-17 09:20',
    });
    expect(brief.cards[2]).toMatchObject({
      kind: 'approval',
      status: 'pending',
      title: '请确认：明天 10:00 散步',
      ref: { approval_id: approvalId },
    });
    expect(brief.meta).toEqual({
      brief_state: 'day-in-progress',
      timezone_note: null,
    });

    const again = await getBrief(deps, ownerId, 'Asia/Shanghai', {}, 'req-test');
    expect(again).toEqual(brief);
  });

  it('does not convert when the query timezone differs; it only notes it', async () => {
    const ownerId = randomUUID();
    await seedTask(pool, ownerId, {
      state: 'scheduled',
      fireAt: '2026-10-17T01:20:00Z',
      wallTime: '2026-10-17 09:20',
      note: '喝水',
    });
    const brief = await getBrief(
      { pool, tzdbVersion: 'fixture-v1', timeContext, now: () => NOW },
      ownerId,
      'Asia/Shanghai',
      { timezone: 'America/New_York' },
      'req-test',
    );
    expect(brief.timezone_id).toBe('Asia/Shanghai');
    expect(brief.cards[0]).toMatchObject({ fire_at_local: '2026-10-17 09:20' });
    expect(brief.meta.timezone_note).toContain('未换算');
  });

  it('returns an empty brief for a day without cards and accepts an explicit date', async () => {
    const ownerId = randomUUID();
    const brief = await getBrief(
      { pool, tzdbVersion: 'fixture-v1', timeContext, now: () => NOW },
      ownerId,
      'Asia/Shanghai',
      { date: '2026-10-19' },
      'req-test',
    );
    expect(brief).toMatchObject({
      date: '2026-10-19',
      summary: { pending_count: 0, fired_count: 0 },
      cards: [],
      meta: { brief_state: 'empty', timezone_note: null },
    });
  });

  it('rejects invalid dates, invalid timezone, and non-ready DB', async () => {
    const deps = { pool, tzdbVersion: 'fixture-v1', timeContext, now: () => NOW };
    await expectApplicationRejection(
      getBrief(deps, randomUUID(), 'Asia/Shanghai', { date: '2026-02-30' }, 'req'),
      { status: 400 },
    );
    await expectApplicationRejection(
      getBrief(deps, randomUUID(), 'Not/AZone', { date: '2026-10-19' }, 'req'),
      { status: 400 },
    );
    await expectApplicationRejection(
      getBrief({ pool: null, tzdbVersion: 'fixture-v1' }, randomUUID(), 'Asia/Shanghai', {}, 'req'),
      { status: 503 },
    );
    await expectApplicationRejection(
      getBrief({ pool, tzdbVersion: undefined }, randomUUID(), 'Asia/Shanghai', {}, 'req'),
      { status: 503 },
    );
  });

  it('uses UTC without a preference and includes cross-zone tasks at the half-open boundaries', async () => {
    const ownerId = randomUUID();
    for (const [fireAt, wallTime, timezoneId, note] of [
      ['2026-10-16T23:59:59Z', '2026-10-17 07:59', 'Asia/Shanghai', 'before'],
      ['2026-10-17T00:00:00Z', '2026-10-17 08:00', 'Asia/Shanghai', 'start'],
      ['2026-10-17T23:59:59Z', '2026-10-18 07:59', 'Asia/Shanghai', 'end'],
      ['2026-10-18T00:00:00Z', '2026-10-18 08:00', 'Asia/Shanghai', 'after'],
    ]) {
      await seedTask(pool, ownerId, { state: 'scheduled', fireAt, wallTime, timezoneId, note });
    }
    const brief = await getBrief({ pool, now: () => NOW }, ownerId, null, {}, 'req');
    expect(brief.timezone_id).toBe('UTC');
    expect(brief.cards.map((card) => card.title)).toEqual(['start', 'end']);
    expect(brief.cards[1]).toMatchObject({ fire_at_local: '2026-10-18 07:59' });
  });

  it('selects pending approvals by the browsing day rather than their frozen date', async () => {
    const ownerId = randomUUID();
    const included = await seedPendingApproval(pool, ownerId, {
      fireAt: '2026-10-17T23:59:59Z',
      wallTime: '2026-10-18 07:59',
      text: 'included',
    });
    await seedPendingApproval(pool, ownerId, {
      fireAt: '2026-10-18T00:00:00Z',
      wallTime: '2026-10-18 08:00',
      text: 'excluded',
    });
    const brief = await getBrief({ pool, now: () => NOW }, ownerId, null, {}, 'req');
    expect(brief.summary.pending_count).toBe(1);
    expect(brief.cards).toHaveLength(1);
    expect(brief.cards[0]).toMatchObject({ ref: { approval_id: included } });
  });

  it.each([
    ['2026-03-08', '2026-03-08T05:00:00Z', '2026-03-09T03:59:59Z', '2026-03-09T04:00:00Z'],
    ['2026-11-01', '2026-11-01T04:00:00Z', '2026-11-02T04:59:59Z', '2026-11-02T05:00:00Z'],
  ])('uses both local midnights for DST day %s', async (date, start, last, end) => {
    const ownerId = randomUUID();
    for (const [fireAt, note] of [
      [start, 'start'],
      [last, 'last'],
      [end, 'after'],
    ]) {
      await seedTask(pool, ownerId, {
        state: 'scheduled',
        fireAt,
        wallTime: '2026-01-01 08:00',
        timezoneId: 'Asia/Shanghai',
        note,
      });
    }
    const brief = await getBrief(
      { pool, tzdbVersion: 'fixture-v1', timeContext, now: () => NOW },
      ownerId,
      'America/New_York',
      { date },
      'req',
    );
    expect(brief.cards.map((card) => card.title)).toEqual(['start', 'last']);
    expect(brief.cards[0]).toMatchObject({ fire_at_local: '2026-01-01 08:00' });
  });

  it('projects tool cards in the UTC browsing day when no preference exists', async () => {
    const ownerId = randomUUID();
    const id = await seedTask(pool, ownerId, {
      state: 'scheduled',
      fireAt: '2026-10-17T23:59:59Z',
      wallTime: '2026-10-18 07:59',
      timezoneId: 'Asia/Shanghai',
      note: '跨时区',
    });
    const client = await pool.connect();
    try {
      const result = await readToolBriefCards(client, ownerId, { date: '2026-10-17' });
      expect(result.cards).toHaveLength(1);
      expect(result.cards[0]).toMatchObject({
        card_id: id,
        body_text: '2026-10-18 07:59（Asia/Shanghai）',
      });
    } finally {
      client.release();
    }
  });

  it('serves the HTTP envelope and guards unauthenticated requests', async () => {
    const ownerId = randomUUID();
    await seedTask(pool, ownerId, {
      state: 'scheduled',
      fireAt: '2026-10-17T01:20:00Z',
      wallTime: '2026-10-17 09:20',
      note: '喝水',
    });
    const snapshotSql = `SELECT
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM tasks t WHERE t.owner_id = $1) AS tasks,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM approvals a WHERE a.owner_id = $1) AS approvals,
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM task_events e WHERE e.owner_id = $1) AS events`;
    const before = (await pool.query(snapshotSql, [ownerId])).rows;
    const actor = {
      ownerId,
      sessionId: null,
      displayName: 'tester',
      timezoneId: 'Asia/Shanghai',
    };
    const ok = fakePair('GET', '/api/v1/brief?date=2026-10-17');
    await handleRequest(ok.req, ok.res, {
      pool,
      tzdbVersion: 'fixture-v1',
      resolveActor: async () => actor,
    });
    expect(ok.res.status).toBe(200);
    const payload = ok.body();
    expect(payload).toMatchObject({
      code: 0,
      data: { date: '2026-10-17', timezone_id: 'Asia/Shanghai' },
    });
    expect((await pool.query(snapshotSql, [ownerId])).rows).toEqual(before);

    const denied = fakePair('GET', '/api/v1/brief');
    await handleRequest(denied.req, denied.res, {
      pool,
      tzdbVersion: 'fixture-v1',
      resolveActor: async () => null,
    });
    expect(denied.res.status).toBe(401);
  });
});
