import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  createTaskApproval,
  createCancelTaskApproval,
} from '../../src/modules/approvals/create.js';
import { confirmApproval, rejectApproval } from '../../src/modules/approvals/confirm.js';
import { reviseApproval, revisionRequestHash } from '../../src/modules/approvals/revise.js';
import { ReviseBodySchema } from '../../src/modules/approvals/schemas.js';
import { getApprovalDetail } from '../../src/modules/approvals/service.js';
import { loadTimeContext, createTimeContext } from '../../src/modules/time/context.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedApproval,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const healthy = loadTimeContext('fixture-v1');
const unavailable = createTimeContext('fixture-v1', null, null);
const raw = '2026-11-02 09:20 喝水';
function body(raw_text = raw) {
  return { raw_text, confirmed_timezone: 'Asia/Shanghai', idempotency_key: randomUUID() };
}
async function state(pool: Pool, id: string) {
  return (await pool.query('SELECT * FROM approvals WHERE id = $1', [id])).rows[0];
}
async function reservations(pool: Pool, owner: string) {
  return (await pool.query('SELECT * FROM approval_revision_requests WHERE owner_id = $1', [owner]))
    .rows;
}
async function counts(pool: Pool, owner: string) {
  const result: Record<string, number> = {};
  for (const table of ['approvals', 'tasks', 'task_events', 'outbox', 'notifications']) {
    result[table] = (
      await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1`, [owner])
    ).rows[0].n;
  }
  return result;
}
async function confirmBody(pool: Pool, owner: string, id: string) {
  const { detail } = await getApprovalDetail({ pool }, owner, id);
  return {
    presentation_hash: detail.presentation_hash,
    seen_content: detail.echo_text,
    idempotency_key: randomUUID(),
  };
}
async function waitBlocked(pool: Pool, locker: PoolClient) {
  const pid = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  for (let n = 0; n < 200; n++) {
    const { rows } = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked',
      [pid],
    );
    if (rows[0].blocked) return;
    await pool.query('SELECT pg_sleep(0.01)');
  }
  throw new Error('writer did not reach the target lock');
}

maybe('approval revise durable PostgreSQL behavior', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });
  const revise = (owner: string, id: string, input: unknown) =>
    reviseApproval({ pool, timeContext: healthy }, owner, id, input);

  it('hash is domain-separated UTF8 length prefix, exact bytes, lowercase target and default none', () => {
    const target = randomUUID();
    const input = ReviseBodySchema.parse(body('é 明天 9:20 喝水'));
    const fields = [
      'along-approval-revise/v1',
      target,
      input.raw_text,
      input.confirmed_timezone,
      'none',
    ];
    const expected = createHash('sha256')
      .update(fields.map((v) => `${Buffer.byteLength(v, 'utf8')}:${v}`).join(''))
      .digest('hex');
    expect(revisionRequestHash(target.toUpperCase(), input)).toBe(expected);
    expect(
      revisionRequestHash(target, { ...input, raw_text: input.raw_text.normalize('NFD') }),
    ).not.toBe(expected);
    expect(revisionRequestHash(target, { ...input, raw_text: ` ${input.raw_text}` })).not.toBe(
      expected,
    );
    expect(
      revisionRequestHash(target, { ...input, confirmed_timezone: ' Asia/Shanghai' }),
    ).not.toBe(expected);
  });

  it('owner/body failures and unavailable actual rules precede reservation and expiry writes', async () => {
    const old = await seedApproval(pool, { expiresInHours: -1 });
    for (const input of [
      null,
      [],
      {},
      { ...body(), raw_text: '' },
      { ...body(), raw_text: 'x'.repeat(20001) },
      { ...body(), confirmed_timezone: null },
      { ...body(), confirmed_timezone: 'x'.repeat(101) },
      { ...body(), fold_choice: null },
      { ...body(), fold_choice: 'third' },
      { ...body(), presentation_hash: 'x' },
      { ...body(), idempotency_key: 'x' },
    ]) {
      await expect(revise(old.ownerId, old.id, input)).rejects.toMatchObject({ httpStatus: 400 });
    }
    await expect(revise(randomUUID(), old.id, body())).rejects.toMatchObject({ httpStatus: 403 });
    await expect(revise(old.ownerId, randomUUID(), body())).rejects.toMatchObject({
      httpStatus: 404,
    });
    await expect(
      reviseApproval({ pool, timeContext: unavailable }, old.ownerId, old.id, body()),
    ).rejects.toMatchObject({ httpStatus: 503, errorCode: 'TZDB_UNAVAILABLE' });
    expect(await reservations(pool, old.ownerId)).toHaveLength(0);
    expect((await state(pool, old.id)).state).toBe('pending');
    for (const action of [confirmApproval, rejectApproval]) {
      const input =
        action === confirmApproval
          ? await confirmBody(pool, old.ownerId, old.id)
          : { idempotency_key: randomUUID() };
      await expect(action({ pool }, randomUUID(), old.id, input)).rejects.toMatchObject({
        httpStatus: 403,
      });
      expect((await state(pool, old.id)).state).toBe('pending');
    }
  });

  it('same-key concurrent replay, body conflict and cross-target conflict never duplicate work', async () => {
    const old = await seedApproval(pool, {});
    const input = body();
    const [first, second] = await Promise.all([
      revise(old.ownerId, old.id.toUpperCase(), input),
      revise(old.ownerId, old.id, { ...input, fold_choice: 'none' }),
    ]);
    expect(first.successor_approval_id).toBe(second.successor_approval_id);
    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
    expect(Object.keys(first).sort()).toEqual([
      'approval_id',
      'duplicate',
      'successor_approval_id',
    ]);
    await expect(
      revise(old.ownerId, old.id, { ...input, raw_text: `${raw} ` }),
    ).rejects.toMatchObject({ httpStatus: 409, errorCode: 'STATE_CONFLICT' });
    const sibling = await seedApproval(pool, { ownerId: old.ownerId });
    await expect(revise(old.ownerId, sibling.id, input)).rejects.toMatchObject({
      httpStatus: 409,
      errorCode: 'STATE_CONFLICT',
    });
    expect(await counts(pool, old.ownerId)).toEqual({
      approvals: 3,
      tasks: 0,
      task_events: 0,
      outbox: 0,
      notifications: 0,
    });
    const other = await seedApproval(pool, {});
    expect((await revise(other.ownerId, other.id, input)).duplicate).toBe(false);
  });

  it('completed result survives consumed, expired or superseded successor and unavailable rules', async () => {
    for (const terminal of ['consumed', 'expired', 'superseded']) {
      const old = await seedApproval(pool, {});
      const input = body();
      const first = await revise(old.ownerId, old.id, input);
      if (terminal === 'consumed')
        await confirmApproval(
          { pool },
          old.ownerId,
          first.successor_approval_id,
          await confirmBody(pool, old.ownerId, first.successor_approval_id),
        );
      if (terminal === 'expired')
        await pool.query("UPDATE approvals SET state='expired' WHERE id=$1", [
          first.successor_approval_id,
        ]);
      if (terminal === 'superseded')
        await revise(old.ownerId, first.successor_approval_id, body('2026-11-03 10:20 喝水'));
      const before = await counts(pool, old.ownerId);
      expect(
        await reviseApproval({ pool, timeContext: unavailable }, old.ownerId, old.id, input),
      ).toEqual({ ...first, duplicate: true });
      expect(await counts(pool, old.ownerId)).toEqual(before);
    }
  });

  it('null-result reservation fixture resumes at original anchor across midnight with a fresh pool; TTL is from creation', async () => {
    // SQL creates only the interruption boundary fixture, not production crash evidence.
    const old = await seedApproval(pool, {});
    const input = body('后天 23:59 喝水');
    const anchor = (
      await pool.query(`SELECT
      ((date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') - interval '1 minute') AS anchor`)
    ).rows[0].anchor.toISOString();
    await pool.query(
      `INSERT INTO approval_revision_requests(owner_id,idempotency_key,target_approval_id,request_hash,anchor_received_at_utc) VALUES($1,$2,$3,$4,$5)`,
      [
        old.ownerId,
        input.idempotency_key,
        old.id,
        revisionRequestHash(old.id, ReviseBodySchema.parse(input)),
        anchor,
      ],
    );
    const fresh = database.connect();
    try {
      const result = await reviseApproval(
        { pool: fresh, timeContext: healthy },
        old.ownerId,
        old.id,
        input,
      );
      const next = await state(pool, result.successor_approval_id);
      const expectedFire = new Date(new Date(anchor).getTime() + 2 * 86400000);
      expect(next.wall_time).toBe(`${expectedFire.toISOString().slice(0, 10)} 23:59`);
      expect(next.fire_at_utc.toISOString()).toBe(expectedFire.toISOString());
      expect(next.expires_at.getTime() - next.created_at.getTime()).toBe(24 * 3600000);
      expect(next.created_at.toISOString()).not.toBe(anchor);
      expect((await reservations(pool, old.ownerId))[0].anchor_received_at_utc.toISOString()).toBe(
        anchor,
      );
    } finally {
      await fresh.end();
    }
  });

  it('typed normalization failures retain reservation without replacement; ordinary incomplete content is 400', async () => {
    for (const [text, timezone, status, code] of [
      ['2026-03-08 02:30 喝水', 'America/New_York', 422, 'NONEXISTENT_LOCAL_TIME'],
      ['2026-11-01 01:30 喝水', 'America/New_York', 422, 'AMBIGUOUS_LOCAL_TIME'],
      [raw, 'Unknown/Zone', 422, 'UNKNOWN_TIMEZONE'],
      ['2030-11-02 09:20 喝水', 'Asia/Shanghai', 503, 'TZDB_UNAVAILABLE'],
      ['11月2日 9:20 喝水', 'Asia/Shanghai', 400, 'VALIDATION_ERROR'],
      ['2026-11-02 09:20', 'Asia/Shanghai', 400, 'VALIDATION_ERROR'],
      ['23:59 喝水', 'Asia/Shanghai', 400, 'VALIDATION_ERROR'],
      ['2026-11-02 09:20 提醒我（北京时间）', 'Asia/Shanghai', 400, 'VALIDATION_ERROR'],
      ['2026年11月2日 上午9点', 'Asia/Shanghai', 400, 'VALIDATION_ERROR'],
      ['明天 23:59（北京时间）', 'Asia/Shanghai', 400, 'VALIDATION_ERROR'],
      ['11月2日24:00 喝水', 'Asia/Shanghai', 400, 'VALIDATION_ERROR'],
    ] as const) {
      const old = await seedApproval(pool, {});
      const input = { ...body(text), confirmed_timezone: timezone };
      const error = await revise(old.ownerId, old.id, input).catch((e) => e);
      expect(error).toMatchObject({ httpStatus: status, errorCode: code });
      if (code === 'AMBIGUOUS_LOCAL_TIME') {
        expect(error.details).toMatchObject({
          wall_time: '2026-11-01T01:30:00',
          timezone_id: timezone,
          candidates: [{ fold_choice: 'first' }, { fold_choice: 'second' }],
        });
      }
      const requests = await reservations(pool, old.ownerId);
      expect(requests).toHaveLength(1);
      expect(requests[0].successor_approval_id).toBeNull();
      expect(await counts(pool, old.ownerId)).toEqual({
        approvals: 1,
        tasks: 0,
        task_events: 0,
        outbox: 0,
        notifications: 0,
      });
      expect((await state(pool, old.id)).state).toBe('pending');
    }
  });

  it('each replacement write fault rolls back the full chain but retains recoverable reservation', async () => {
    for (const point of ['insert', 'supersede', 'result']) {
      const old = await seedApproval(pool, {});
      const input = body();
      const table = point === 'result' ? 'approval_revision_requests' : 'approvals';
      const event = point === 'insert' ? 'INSERT' : 'UPDATE';
      const condition =
        point === 'insert'
          ? `NEW.supersedes_approval_id = '${old.id}'::uuid`
          : point === 'supersede'
            ? `NEW.id = '${old.id}'::uuid AND NEW.state = 'superseded'`
            : `NEW.target_approval_id = '${old.id}'::uuid AND NEW.successor_approval_id IS NOT NULL`;
      await pool.query(
        `CREATE FUNCTION fail_revision_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected revision fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_revision_write BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_revision_write()`,
      );
      try {
        await expect(revise(old.ownerId, old.id, input)).rejects.toMatchObject({ code: 'P0001' });
        expect((await state(pool, old.id)).state).toBe('pending');
        expect(await counts(pool, old.ownerId)).toEqual({
          approvals: 1,
          tasks: 0,
          task_events: 0,
          outbox: 0,
          notifications: 0,
        });
        expect((await reservations(pool, old.ownerId))[0].successor_approval_id).toBeNull();
      } finally {
        await pool.query(
          `DROP TRIGGER fail_revision_write ON ${table}; DROP FUNCTION fail_revision_write()`,
        );
      }
      const anchor = (await reservations(pool, old.ownerId))[0].anchor_received_at_utc;
      await revise(old.ownerId, old.id, input);
      expect((await reservations(pool, old.ownerId))[0].anchor_received_at_utc).toEqual(anchor);
    }
  });

  it('different keys serialize to one successor and database uniqueness rejects a fork', async () => {
    const old = await seedApproval(pool, {});
    const results = await Promise.allSettled([
      revise(old.ownerId, old.id, body()),
      revise(old.ownerId, old.id, body('2026-11-03 09:20 喝水')),
    ]);
    const winner = results.find((r) => r.status === 'fulfilled');
    const loser = results.find((r) => r.status === 'rejected');
    expect(winner?.status).toBe('fulfilled');
    expect(loser?.status === 'rejected' && loser.reason).toMatchObject({
      httpStatus: 409,
      errorCode: 'APPROVAL_SUPERSEDED',
    });
    expect(
      (await pool.query('SELECT id FROM approvals WHERE supersedes_approval_id=$1', [old.id])).rows,
    ).toHaveLength(1);
    await expect(
      pool.query(
        `INSERT INTO approvals SELECT gen_random_uuid(),owner_id,conversation_id,original_text,fire_at_utc,wall_time,timezone_id,fold,resolved_utc_offset_seconds,tzdb_version,occurrence,presentation_hash,presentation_version,'pending',created_at,expires_at,NULL,supersedes_approval_id,kind,target_task_id,expected_state_version FROM approvals WHERE supersedes_approval_id=$1`,
        [old.id],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'approvals_supersedes_approval_id_uniq' });
  });

  it('revise versus confirm and reject: whichever target writer commits first wins', async () => {
    for (const action of ['confirm', 'reject'] as const) {
      for (const first of ['revise', action]) {
        const old = await seedApproval(pool, {});
        const confirmation = await confirmBody(pool, old.ownerId, old.id);
        const write = () =>
          action === 'confirm'
            ? confirmApproval({ pool }, old.ownerId, old.id, confirmation)
            : rejectApproval({ pool }, old.ownerId, old.id, { idempotency_key: randomUUID() });
        const locker = await pool.connect();
        try {
          await locker.query('BEGIN');
          // Permit reservation FK KEY SHARE while ordering actual target writers.
          await locker.query('SELECT id FROM approvals WHERE id=$1 FOR NO KEY UPDATE', [old.id]);
          const one = (first === 'revise' ? revise(old.ownerId, old.id, body()) : write()).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          await waitBlocked(pool, locker);
          const two = (first === 'revise' ? write() : revise(old.ownerId, old.id, body())).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          await locker.query('COMMIT');
          const [a, b] = await Promise.all([one, two]);
          expect(a).toHaveProperty('value');
          expect(b).toMatchObject({
            error: {
              httpStatus: 409,
              errorCode: first === 'revise' ? 'APPROVAL_SUPERSEDED' : 'STATE_CONFLICT',
            },
          });
          const after = await counts(pool, old.ownerId);
          expect(after.approvals).toBe(first === 'revise' ? 2 : 1);
          expect(after.tasks).toBe(first === 'confirm' ? 1 : 0);
        } finally {
          await locker.query('ROLLBACK');
          locker.release();
        }
      }
    }
  });

  it('cancel_task is not revisable and never causes additional task-side writes', async () => {
    const old = await seedApproval(pool, {});
    const confirmed = await confirmApproval(
      { pool },
      old.ownerId,
      old.id,
      await confirmBody(pool, old.ownerId, old.id),
    );
    const cancel = await createCancelTaskApproval(pool, {
      ownerId: old.ownerId,
      conversationId: randomUUID(),
      originalText: '取消喝水',
      targetTaskId: confirmed.task_id,
      expectedStateVersion: 1,
      wallTime: '2026-11-02 09:20',
      timezoneId: 'Asia/Shanghai',
      fold: 0,
      offsetSeconds: 28800,
      fireAtUtc: '2026-11-02T01:20:00Z',
      tzdbVersion: 'fixture-v1',
    });
    const before = await counts(pool, old.ownerId);
    await expect(revise(old.ownerId, cancel.approvalId, body())).rejects.toMatchObject({
      httpStatus: 409,
      errorCode: 'STATE_CONFLICT',
    });
    expect(await counts(pool, old.ownerId)).toEqual(before);
    expect((await state(pool, cancel.approvalId)).state).toBe('pending');
  });

  it('ambiguous choice uses a new key and confirms only the selected occurrence and frozen offset', async () => {
    for (const fold of ['first', 'second'] as const) {
      const old = await seedApproval(pool, {});
      const input = { ...body('2026-11-01 01:30 喝水'), confirmed_timezone: 'America/New_York' };
      await expect(revise(old.ownerId, old.id, input)).rejects.toMatchObject({
        errorCode: 'AMBIGUOUS_LOCAL_TIME',
      });
      await expect(
        revise(old.ownerId, old.id, { ...input, fold_choice: fold }),
      ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
      const next = await revise(old.ownerId, old.id, {
        ...input,
        fold_choice: fold,
        idempotency_key: randomUUID(),
      });
      const row = await state(pool, next.successor_approval_id);
      expect(row.fold).toBe(fold === 'first' ? 0 : 1);
      expect(row.resolved_utc_offset_seconds).toBe(fold === 'first' ? -14400 : -18000);
      expect(row.fire_at_utc.toISOString()).toBe(
        fold === 'first' ? '2026-11-01T05:30:00.000Z' : '2026-11-01T06:30:00.000Z',
      );
      const { detail } = await getApprovalDetail({ pool }, old.ownerId, next.successor_approval_id);
      expect(detail.echo_text).toContain(fold === 'first' ? '第一次出现' : '第二次出现');
      const offset = fold === 'first' ? 'UTC-04:00' : 'UTC-05:00';
      const otherOffset = fold === 'first' ? 'UTC-05:00' : 'UTC-04:00';
      expect(detail.echo_text).toContain(offset);
      await expect(
        confirmApproval({ pool }, old.ownerId, next.successor_approval_id, {
          presentation_hash: detail.presentation_hash,
          seen_content: detail.echo_text.replace(offset, otherOffset),
          idempotency_key: randomUUID(),
        }),
      ).rejects.toMatchObject({ errorCode: 'PRESENTATION_MISMATCH' });
      expect((await counts(pool, old.ownerId)).tasks).toBe(0);
      await confirmApproval(
        { pool },
        old.ownerId,
        next.successor_approval_id,
        await confirmBody(pool, old.ownerId, next.successor_approval_id),
      );
      expect(await counts(pool, old.ownerId)).toMatchObject({
        tasks: 1,
        task_events: 1,
        outbox: 1,
        notifications: 0,
      });
    }
  });

  it('expiry during actual shared normalization is rechecked before replacing', async () => {
    const old = await seedApproval(pool, {});
    let delayed = false;
    const delayedRules = new Proxy(healthy, {
      get(target, property, receiver) {
        if (property === 'ruleset' && !delayed) {
          delayed = true;
          // Delay delivery of real rules, not a substitute parser/result/clock.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await pool.query(
      "UPDATE approvals SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
      [old.id],
    );
    await expect(
      reviseApproval({ pool, timeContext: delayedRules }, old.ownerId, old.id, body()),
    ).rejects.toMatchObject({ httpStatus: 410 });
    expect(delayed).toBe(true);
    expect((await state(pool, old.id)).state).toBe('expired');
    expect((await reservations(pool, old.ownerId))[0].successor_approval_id).toBeNull();
    expect(await counts(pool, old.ownerId)).toEqual({
      approvals: 1,
      tasks: 0,
      task_events: 0,
      outbox: 0,
      notifications: 0,
    });
  });

  for (const field of ['expires_at', 'fire_at_utc']) {
    for (const action of ['confirm', 'reject', 'revise']) {
      it(`${action} waits past ${field}, returns 410 and commits expired with no successor/task`, async () => {
        const old = await seedApproval(pool, {});
        const confirmation = await confirmBody(pool, old.ownerId, old.id);
        const locker = await pool.connect();
        await locker.query('BEGIN');
        await locker.query(
          `UPDATE approvals SET ${field}=clock_timestamp()+interval '300 milliseconds' WHERE id=$1`,
          [old.id],
        );
        const pending = (
          action === 'confirm'
            ? confirmApproval({ pool }, old.ownerId, old.id, confirmation)
            : action === 'reject'
              ? rejectApproval({ pool }, old.ownerId, old.id, { idempotency_key: randomUUID() })
              : revise(old.ownerId, old.id, body())
        ).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        try {
          await waitBlocked(pool, locker);
          await locker.query('SELECT pg_sleep(0.35)');
          await locker.query('COMMIT');
          expect(await pending).toMatchObject({
            error: { httpStatus: 410, errorCode: 'APPROVAL_EXPIRED' },
          });
          expect((await state(pool, old.id)).state).toBe('expired');
          expect(await counts(pool, old.ownerId)).toEqual({
            approvals: 1,
            tasks: 0,
            task_events: 0,
            outbox: 0,
            notifications: 0,
          });
        } finally {
          await locker.query('ROLLBACK');
          locker.release();
        }
      });
    }
  }

  it('new target already past returns 410 without expiring a still-valid old approval', async () => {
    const old = await seedApproval(pool, {});
    await expect(revise(old.ownerId, old.id, body('2026-01-02 09:20 喝水'))).rejects.toMatchObject({
      httpStatus: 410,
    });
    expect((await state(pool, old.id)).state).toBe('pending');
    expect(await counts(pool, old.ownerId)).toEqual({
      approvals: 1,
      tasks: 0,
      task_events: 0,
      outbox: 0,
      notifications: 0,
    });
  });

  it('same presentation is legal; new details confirm twice to exactly one task', async () => {
    const ownerId = randomUUID();
    const old = await createTaskApproval(pool, {
      ownerId,
      conversationId: null,
      originalText: raw,
      wallTime: '2026-11-02 09:20',
      timezoneId: 'Asia/Shanghai',
      fold: 0,
      foldChoice: 'none',
      offsetSeconds: 28800,
      fireAtUtc: '2026-11-02T01:20:00Z',
      tzdbVersion: 'fixture-v1',
    });
    const oldBody = await confirmBody(pool, ownerId, old.approvalId);
    const result = await revise(ownerId, old.approvalId, body());
    const { detail } = await getApprovalDetail({ pool }, ownerId, result.successor_approval_id);
    expect(detail.presentation_hash).toBe(old.presentationHash);
    expect(detail.recreated_from).toBe(old.approvalId);
    await expect(confirmApproval({ pool }, ownerId, old.approvalId, oldBody)).rejects.toMatchObject(
      { errorCode: 'APPROVAL_SUPERSEDED' },
    );
    const input = await confirmBody(pool, ownerId, result.successor_approval_id);
    const [a, b] = await Promise.all([
      confirmApproval({ pool }, ownerId, result.successor_approval_id, input),
      confirmApproval({ pool }, ownerId, result.successor_approval_id, input),
    ]);
    expect(a.task_id).toBe(b.task_id);
    expect((await counts(pool, ownerId)).tasks).toBe(1);
  });

  it('changed presentation rejects old material; frozen read/confirm/reject do not require healthy rules', async () => {
    const old = await seedApproval(pool, {});
    const oldBody = await confirmBody(pool, old.ownerId, old.id);
    const result = await revise(old.ownerId, old.id, body());
    await expect(
      confirmApproval({ pool }, old.ownerId, result.successor_approval_id, oldBody),
    ).rejects.toMatchObject({ errorCode: 'PRESENTATION_MISMATCH' });
    const input = await confirmBody(pool, old.ownerId, result.successor_approval_id);
    await confirmApproval({ pool }, old.ownerId, result.successor_approval_id, input);
    const rejected = await seedApproval(pool, {});
    await rejectApproval({ pool }, rejected.ownerId, rejected.id, {
      idempotency_key: randomUUID(),
    });
  });
});
