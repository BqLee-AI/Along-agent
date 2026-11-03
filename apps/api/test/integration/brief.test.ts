// Issue #10: GET /brief deterministic projection.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { handleRequest } from '../../src/http/app.js';
import { getBrief } from '../../src/modules/brief/service.js';
import { BriefResponseSchema } from '../../src/modules/brief/schemas.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedApproval,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
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

    const deps = { pool, tzdbVersion: 'fixture-v1', now: () => NOW };
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
      { pool, tzdbVersion: 'fixture-v1', now: () => NOW },
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
      { pool, tzdbVersion: 'fixture-v1', now: () => NOW },
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

  it('rejects invalid dates, missing timezone, and non-ready DB', async () => {
    const deps = { pool, tzdbVersion: 'fixture-v1', now: () => NOW };
    await expect(
      getBrief(deps, randomUUID(), 'Asia/Shanghai', { date: '2026-02-30' }, 'req'),
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(getBrief(deps, randomUUID(), null, {}, 'req')).rejects.toMatchObject({
      httpStatus: 400,
    });
    await expect(
      getBrief(deps, randomUUID(), 'Not/AZone', { date: '2026-10-19' }, 'req'),
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      getBrief({ pool: null, tzdbVersion: 'fixture-v1' }, randomUUID(), 'Asia/Shanghai', {}, 'req'),
    ).rejects.toMatchObject({ httpStatus: 503 });
    await expect(
      getBrief({ pool, tzdbVersion: undefined }, randomUUID(), 'Asia/Shanghai', {}, 'req'),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });

  it('serves the HTTP envelope and guards unauthenticated requests', async () => {
    const ownerId = randomUUID();
    await seedTask(pool, ownerId, {
      state: 'scheduled',
      fireAt: '2026-10-17T01:20:00Z',
      wallTime: '2026-10-17 09:20',
      note: '喝水',
    });
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

    const denied = fakePair('GET', '/api/v1/brief');
    await handleRequest(denied.req, denied.res, {
      pool,
      tzdbVersion: 'fixture-v1',
      resolveActor: async () => null,
    });
    expect(denied.res.status).toBe(401);
  });
});
