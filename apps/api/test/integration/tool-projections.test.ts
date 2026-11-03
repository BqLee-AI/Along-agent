import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { readCancelTaskCandidate, readToolTaskList } from '../../src/modules/tasks/tool-query.js';
import { readToolBriefCards } from '../../src/modules/brief/tool-query.js';
import { isActiveOwner, readUserPreferences } from '../../src/modules/identity/preferences.js';
import {
  admitTestUser,
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;

maybe('owned tool query-client projections', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });

  async function task(
    client: PoolClient,
    ownerId: string,
    input: {
      state?: string;
      wallTime?: string;
      fireAt?: string;
      note?: string | null;
      timezoneId?: string;
    } = {},
  ) {
    const id = randomUUID();
    // New rows require exactly one real creation source; this fixture approval
    // lives and rolls back with the caller transaction.
    const sourceApprovalId = randomUUID();
    await client.query(
      `INSERT INTO approvals(id,owner_id,original_text,fire_at_utc,wall_time,timezone_id,
         fold,resolved_utc_offset_seconds,tzdb_version,occurrence,presentation_hash,
         presentation_version,state,expires_at)
       VALUES($1,$2,'fixture source','2035-01-01T00:00:00Z','2035-01-01 00:00',
         'Asia/Shanghai',0,28800,'fixture-v1','single','fixture-source','v1',
         'consumed','2035-01-02T00:00:00Z')`,
      [sourceApprovalId, ownerId],
    );
    await client.query(
      `INSERT INTO tasks(id,owner_id,state,fire_at_utc,wall_time,timezone_id,fold,
         resolved_utc_offset_seconds,tzdb_version,original_note,state_version,source_approval_id)
       VALUES($1,$2,$3,$4,$5,$6,1,-18000,'fixture-v1',$7,7,$8)`,
      [
        id,
        ownerId,
        input.state ?? 'saved',
        input.fireAt ?? '2026-11-02T01:20:00Z',
        input.wallTime ?? '2026-11-02 09:20',
        input.timezoneId ?? 'Asia/Shanghai',
        input.note ?? null,
        sourceApprovalId,
      ],
    );
    return id;
  }

  it('uses the caller transaction for cancellation metadata, preferences and every projection', async () => {
    const ownerId = randomUUID();
    const client = await pool.connect();
    let taskId: string;
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO users(id,auth_email,display_name,timezone_id) VALUES($1,$2,'tester','Europe/Paris')",
        [ownerId, `${ownerId}@fixture.test`],
      );
      await admitTestUser(client, ownerId);
      taskId = await task(client, ownerId, { note: '  保留标题\n第二行' });
      expect(await readCancelTaskCandidate(client, ownerId, taskId)).toEqual({
        id: taskId,
        owner_id: ownerId,
        state: 'saved',
        state_version: 7,
        wall_time: '2026-11-02 09:20',
        timezone_id: 'Asia/Shanghai',
        fold: 1,
        resolved_utc_offset_seconds: -18000,
        tzdb_version: 'fixture-v1',
        fire_at_utc: new Date('2026-11-02T01:20:00Z'),
        original_note: '  保留标题\n第二行',
      });
      expect(await readCancelTaskCandidate(client, randomUUID(), taskId)).toBeNull();
      expect(await readCancelTaskCandidate(client, ownerId, randomUUID())).toBeNull();
      expect(await readUserPreferences(client, ownerId)).toEqual({ timezone_id: 'Europe/Paris' });
      expect(await readUserPreferences(client, randomUUID())).toEqual({ timezone_id: null });
      expect(await isActiveOwner(client, ownerId)).toBe(true);
      expect(await isActiveOwner(client, randomUUID())).toBe(false);
      for (const status of ['disabled', 'deleted_requested']) {
        await client.query('UPDATE users SET status=$2 WHERE id=$1', [ownerId, status]);
        expect(await isActiveOwner(client, ownerId)).toBe(false);
      }
      expect(
        (await readToolTaskList(client, ownerId, { limit: 20 })).tasks.map((row) => row.task_id),
      ).toEqual([taskId]);
      expect(
        (await readToolBriefCards(client, ownerId, { date: '2026-11-02' })).cards.map(
          (row) => row.card_id,
        ),
      ).toEqual([taskId]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await pool.query('SELECT id FROM tasks WHERE owner_id=$1', [ownerId])).rows).toEqual(
      [],
    );
    expect((await pool.query('SELECT id FROM users WHERE id=$1', [ownerId])).rows).toEqual([]);
  });

  it('retains active-state defaults, explicit terminal-state filters, UTC ordering and limit-plus-one pagination', async () => {
    const ownerId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const later = await task(client, ownerId, {
        state: 'scheduled',
        fireAt: '2026-11-02T04:00:00Z',
        wallTime: '2026-11-02 01:00',
        note: '后',
      });
      const note = '  标题不做修剪\n下一行' + '字'.repeat(35);
      const first = await task(client, ownerId, {
        state: 'cancel_pending',
        fireAt: '2026-11-02T01:00:00Z',
        wallTime: '2026-11-02 20:00',
        note,
      });
      const second = await task(client, ownerId, {
        state: 'pending_schedule',
        fireAt: '2026-11-02T02:00:00Z',
      });
      const fired = await task(client, ownerId, { state: 'fired', fireAt: '2026-11-02T00:00:00Z' });
      await task(client, ownerId, { state: 'cancelled', fireAt: '2026-11-01T00:00:00Z' });
      await task(client, randomUUID(), { fireAt: '2026-10-31T00:00:00Z' });
      expect(await readToolTaskList(client, ownerId, { limit: 1 })).toEqual({
        tasks: [
          {
            task_id: first,
            note_preview: note.slice(0, 30),
            fire_at_local_text: '2026-11-02 20:00',
            timezone_id: 'Asia/Shanghai',
            state: 'cancel_pending',
          },
        ],
        has_more: true,
      });
      const exact = await readToolTaskList(client, ownerId, { limit: 3 });
      expect(exact.tasks.map((row) => row.task_id)).toEqual([first, second, later]);
      expect(exact.tasks[1]?.note_preview).toBe('');
      expect(exact.has_more).toBe(false);
      expect(await readToolTaskList(client, ownerId, { state: 'fired', limit: 1 })).toEqual({
        tasks: [
          {
            task_id: fired,
            note_preview: '',
            fire_at_local_text: '2026-11-02 09:20',
            timezone_id: 'Asia/Shanghai',
            state: 'fired',
          },
        ],
        has_more: false,
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('keeps raw UUID card IDs, exact 30-character titles, wall-date and card filters, wall-time ordering and the 50-card cap', async () => {
    const ownerId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const title = '  原始标题\n第二行' + '字'.repeat(35);
      const later = await task(client, ownerId, {
        state: 'fired',
        wallTime: '2026-11-02 10:00',
        fireAt: '2026-11-01T01:00:00Z',
        note: title,
        timezoneId: 'Europe/Paris',
      });
      const earlier = await task(client, ownerId, {
        state: 'missed',
        wallTime: '2026-11-02 08:00',
        fireAt: '2026-11-03T01:00:00Z',
      });
      const cancelled = await task(client, ownerId, {
        state: 'cancelled',
        wallTime: '2026-11-02 07:00',
      });
      const otherDate = await task(client, ownerId, { wallTime: '2026-11-03 07:00' });
      const foreign = await task(client, randomUUID(), { wallTime: '2026-11-02 06:00' });
      const brief = await readToolBriefCards(client, ownerId, { date: '2026-11-02' });
      expect(brief).toEqual({
        brief_id: 'brief:2026-11-02',
        date: '2026-11-02',
        cards: [
          {
            card_id: earlier,
            kind: 'task',
            title: '',
            body_text: '2026-11-02 08:00（Asia/Shanghai）',
            source_refs: [earlier],
            presentation_version: 'v1',
          },
          {
            card_id: later,
            kind: 'task',
            title: title.slice(0, 30),
            body_text: '2026-11-02 10:00（Europe/Paris）',
            source_refs: [later],
            presentation_version: 'v1',
          },
        ],
      });
      expect(
        (
          await readToolBriefCards(client, ownerId, {
            date: '2026-11-02',
            card_ids: [later, foreign, cancelled, otherDate],
          })
        ).cards,
      ).toEqual([brief.cards[1]!]);
      expect(
        (await readToolBriefCards(client, ownerId, { date: '2026-11-02', card_ids: [] })).cards,
      ).toEqual([]);
      expect(
        await readToolBriefCards(client, ownerId, { date: '2026-11-02', card_ids: null }),
      ).toEqual(brief);
      for (let minute = 0; minute < 51; minute++) {
        await task(client, ownerId, {
          wallTime: `2026-11-02 11:${String(minute).padStart(2, '0')}`,
        });
      }
      const capped = await readToolBriefCards(client, ownerId, { date: '2026-11-02' });
      expect(capped.cards).toHaveLength(50);
      expect(capped.cards[49]?.body_text).toBe('2026-11-02 11:47（Asia/Shanghai）');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
