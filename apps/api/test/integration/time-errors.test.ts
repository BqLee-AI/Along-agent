import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { ThreadEventSchema, type ThreadEvent } from '@along/stream-protocol';
import { handleRequest, type AppDeps } from '../../src/http/app.js';
import type { Actor } from '../../src/http/auth.js';
import { createTimeContext, loadTimeContext } from '../../src/modules/time/context.js';
import { executeRun, startConversationRun } from '../../src/modules/conversations/service.js';
import { listRunEvents } from '../../src/modules/conversations/repository.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
  seedApproval,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const healthy = loadTimeContext('fixture-v1');
const unavailable = createTimeContext('fixture-v1', null, null);
const proposal = {
  raw_text: '2026-11-01 01:30 提醒我喝水',
  confirmed_timezone: 'America/New_York',
};
const TABLES = [
  'conversations',
  'messages',
  'agent_runs',
  'run_attempts',
  'run_checkpoints',
  'conversation_idempotency',
  'tool_calls',
  'approvals',
  'tasks',
  'task_events',
  'outbox',
  'notifications',
] as const;

async function counts(pool: Pool, ownerId: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of TABLES) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE owner_id = $1`,
      [ownerId],
    );
    result[table] = rows[0].n;
  }
  return result;
}

function frames(text: string): ThreadEvent[] {
  return text
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => ThreadEventSchema.parse(JSON.parse(line.slice(6))));
}

async function withApi(
  pool: Pool,
  use: (base: string, deps: AppDeps, ownerId: string) => Promise<void>,
): Promise<void> {
  const ownerId = randomUUID();
  await pool.query(
    "INSERT INTO users (id, auth_email, display_name, timezone_id) VALUES ($1,$2,'A4 tester','Asia/Shanghai')",
    [ownerId, `a4-${ownerId}@along.test`],
  );
  const actor: Actor = {
    ownerId,
    sessionId: null,
    displayName: 'A4 tester',
    timezoneId: 'Asia/Shanghai',
  };
  const deps: AppDeps = {
    pool,
    timeContext: healthy,
    tzdbVersion: 'fixture-v1',
    resolveActor: async () => actor,
  };
  const server = createServer((req, res) => {
    void handleRequest(req, res, deps);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, deps, ownerId);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function post(base: string, body: unknown, key = randomUUID()): Promise<Response> {
  return fetch(`${base}/api/v1/conversations/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
}

maybe('A4 real HTTP and database boundaries', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });

  for (const state of ['idle', 'checked_out'] as const) {
    it(`survives a real ${state} backend disconnect and reconnects`, async () => {
      const source = `
        import { createPool } from ${JSON.stringify(new URL('../../src/db/pool.ts', import.meta.url).href)};
        const target = createPool();
        const control = createPool();
        const client = await target.connect();
        const before = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const { promise: ended, resolve } = Promise.withResolvers();
        client.once('end', resolve);
        if (${JSON.stringify(state)} === 'idle') client.release();
        const terminated = (await control.query('SELECT pg_terminate_backend($1) AS terminated', [before])).rows[0].terminated;
        if (!terminated) throw new Error('owned backend was not terminated');
        await ended;
        if (${JSON.stringify(state)} === 'checked_out') client.release();
        const after = (await target.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        console.log(JSON.stringify({ before, after, terminated }));
        await target.end();
        await control.end();
      `;
      const child = Bun.spawn([process.execPath, '--eval', source], {
        env: { ...process.env, DATABASE_URL: database.connectionString },
        signal: AbortSignal.timeout(3_000),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(stderr);
      const result = JSON.parse(stdout) as {
        before: number;
        after: number;
        terminated: boolean;
      };
      expect(result.terminated).toBe(true);
      expect(result.after).not.toBe(result.before);
    });
  }

  it('bad rules reject before every new audit/commitment row and leave the key reusable', async () => {
    await withApi(pool, async (base, deps, ownerId) => {
      deps.timeContext = unavailable;
      const before = await counts(pool, ownerId);
      const key = randomUUID();
      const response = await post(base, proposal, key);
      expect(response.status).toBe(503);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({
        code: 400006,
        data: null,
        error: { code: 'TZDB_UNAVAILABLE' },
      });
      expect(await counts(pool, ownerId)).toEqual(before);
      deps.timeContext = healthy;
      const repaired = await post(base, proposal, key);
      expect(repaired.status).toBe(200);
      expect(frames(await repaired.text()).at(-1)).toMatchObject({
        type: 'thread.failed',
        payload: { error: { code: 'AMBIGUOUS_LOCAL_TIME', http_status: 422 } },
      });
    });
  });

  it('authentication, CSRF, body, owner, missing resource and idempotency conflicts precede the rules gate', async () => {
    await withApi(pool, async (base, deps, ownerId) => {
      const started = await startConversationRun(
        { pool, timeContext: healthy },
        ownerId,
        randomUUID(),
        { raw_text: '你好' },
        randomUUID(),
      );
      const key = randomUUID();
      await startConversationRun(
        { pool, timeContext: healthy },
        ownerId,
        randomUUID(),
        proposal,
        key,
      );
      deps.timeContext = unavailable;
      const before = await counts(pool, ownerId);
      const ownerResolver = deps.resolveActor;
      deps.resolveActor = async () => null;
      expect((await post(base, proposal)).status).toBe(401);
      deps.resolveActor = async () => ({
        ownerId,
        sessionId: randomUUID(),
        displayName: 'tester',
        timezoneId: null,
      });
      const csrf = await post(base, proposal);
      expect(csrf.status).toBe(403);
      expect(await csrf.json()).toMatchObject({
        error: { code: 'FORBIDDEN', details: { reason: 'CSRF_MISMATCH' } },
      });
      deps.resolveActor = ownerResolver;
      expect((await post(base, {})).status).toBe(400);
      expect((await post(base, { ...proposal, conversation_id: randomUUID() })).status).toBe(404);
      expect((await post(base, { ...proposal, raw_text: 'different 提醒我' }, key)).status).toBe(
        409,
      );
      expect((await post(base, proposal, key)).status).toBe(409);
      deps.resolveActor = async () => ({
        ownerId: randomUUID(),
        sessionId: null,
        displayName: 'other',
        timezoneId: null,
      });
      expect(
        (await post(base, { ...proposal, conversation_id: started.conversationId })).status,
      ).toBe(403);
      expect(await counts(pool, ownerId)).toEqual(before);
    });
  });

  it('HTTP 200 carries one typed 422/503 terminal, no commitment rows, and exact replay under bad rules', async () => {
    await withApi(pool, async (base, deps, ownerId) => {
      for (const [raw_text, timezone, code, http_status] of [
        ['2027-03-14 02:30 提醒我', 'America/New_York', 'NONEXISTENT_LOCAL_TIME', 422],
        ['2026-11-01 01:30 提醒我', 'America/New_York', 'AMBIGUOUS_LOCAL_TIME', 422],
        ['2028-01-01 09:20 提醒我', 'Asia/Shanghai', 'TZDB_UNAVAILABLE', 503],
        ['火星时间 2026-11-01 01:30 提醒我', 'Asia/Shanghai', 'UNKNOWN_TIMEZONE', 422],
        ['Mars/Olympus 2026-11-01 01:30 提醒我', '', 'UNKNOWN_TIMEZONE', 422],
      ] as const) {
        deps.timeContext = healthy;
        const body = { raw_text, confirmed_timezone: timezone || undefined };
        const key = randomUUID();
        const response = await post(base, body, key);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        const events = frames(await response.text());
        expect(events.map((event) => event.type)).toEqual(['thread.started', 'thread.failed']);
        expect(events[0]).toMatchObject({
          payload: { ruleset_id: healthy.ruleset_id, tzdb_version: healthy.tzdb_version },
        });
        expect(events[1]).toMatchObject({ payload: { error: { code, http_status } } });
        const conversationId = events[0].payload.conversation_id;
        deps.timeContext = unavailable;
        const replay = await post(base, body, key);
        expect(replay.status).toBe(200);
        expect(frames(await replay.text())).toEqual(events);
        const detail = await fetch(`${base}/api/v1/conversations/${conversationId}`);
        expect(detail.status).toBe(200);
        expect(await detail.json()).toMatchObject({ data: { events } });
      }
      const actual = await counts(pool, ownerId);
      for (const table of ['approvals', 'tasks', 'task_events', 'outbox', 'notifications'])
        expect(actual[table]).toBe(0);
    });
  });

  it('request timezone beats the frozen default, while original text beats both compatible fields', async () => {
    await withApi(pool, async (base, _deps, ownerId) => {
      const opened = await startConversationRun(
        { pool, timeContext: healthy },
        ownerId,
        randomUUID(),
        { raw_text: '你好', confirmed_timezone: 'Asia/Shanghai' },
        randomUUID(),
      );
      const override = await post(base, {
        ...proposal,
        conversation_id: opened.conversationId,
        confirmed_timezone: 'Asia/Shanghai',
        confirmed_timezone_id: 'America/New_York',
      });
      expect(frames(await override.text()).at(-1)).toMatchObject({
        type: 'thread.failed',
        payload: { error: { code: 'AMBIGUOUS_LOCAL_TIME' } },
      });
      const explicit = await post(base, {
        raw_text: '纽约时间 2026-11-01 01:30 提醒我',
        conversation_id: opened.conversationId,
        confirmed_timezone_id: 'Asia/Shanghai',
      });
      expect(frames(await explicit.text()).at(-1)).toMatchObject({
        payload: { error: { code: 'AMBIGUOUS_LOCAL_TIME' } },
      });
      const { rows } = await pool.query(
        'SELECT confirmed_timezone_id FROM conversations WHERE id = $1',
        [opened.conversationId],
      );
      expect(rows[0].confirmed_timezone_id).toBe('Asia/Shanghai');
    });
  });

  it('healthy real DB is ready without checking migrations; rules fail before DB and liveness stays independent', async () => {
    await withApi(pool, async (base, deps) => {
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
      const closed = database.connect();
      await closed.end();
      deps.pool = closed;
      const noDb = await fetch(`${base}/readyz`);
      expect(noDb.status).toBe(503);
      expect(await noDb.json()).toEqual({ status: 'not_ready', reason: 'NOT_READY' });
      deps.timeContext = unavailable;
      const both = await fetch(`${base}/readyz`);
      expect(await both.json()).toEqual({ status: 'not_ready', reason: 'TZDB_UNAVAILABLE' });
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    });
  });

  it('bad rules do not block frozen approval reads/confirmation, task reads or cancellation proposals', async () => {
    await withApi(pool, async (base, deps, ownerId) => {
      const seed = await seedApproval(pool, { ownerId });
      deps.timeContext = unavailable;
      const detail = await fetch(`${base}/api/v1/approvals/${seed.id}`);
      expect(detail.status).toBe(200);
      const stored = (await detail.json()) as {
        data: { echo_text: string; presentation_hash: string };
      };
      const confirm = await fetch(`${base}/api/v1/approvals/${seed.id}/actions/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          presentation_hash: seed.presentationHash,
          seen_content: stored.data.echo_text,
          idempotency_key: randomUUID(),
        }),
      });
      expect(confirm.status).toBe(200);
      const confirmed = (await confirm.json()) as { data: { task_id: string } };
      const task = await fetch(`${base}/api/v1/tasks/${confirmed.data.task_id}`);
      expect(task.status).toBe(200);
      const cancel = await post(base, { raw_text: `取消任务 ${confirmed.data.task_id}` });
      expect(cancel.status).toBe(200);
      const events = frames(await cancel.text());
      expect(events.at(-1)?.type).toBe('thread.completed');
      const required = events.find((event) => event.type === 'approval_required');
      expect(required?.type).toBe('approval_required');
      if (required?.type !== 'approval_required') throw new Error('cancel approval missing');
      const cancelDetail = await fetch(`${base}/api/v1/approvals/${required.payload.approval_id}`);
      const echo = (await cancelDetail.json()) as {
        data: { echo_text: string; presentation_hash: string };
      };
      const cancelled = await fetch(
        `${base}/api/v1/approvals/${required.payload.approval_id}/actions/confirm`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            presentation_hash: echo.data.presentation_hash,
            seen_content: echo.data.echo_text,
            idempotency_key: randomUUID(),
          }),
        },
      );
      expect(cancelled.status).toBe(200);
      const { rows } = await pool.query(
        'SELECT t.tzdb_version, t.wall_time, t.fold, t.resolved_utc_offset_seconds, t.fire_at_utc = a.fire_at_utc AS frozen, t.state FROM tasks t JOIN approvals a ON a.id = t.source_approval_id WHERE t.id = $1',
        [confirmed.data.task_id],
      );
      expect(rows[0]).toMatchObject({
        tzdb_version: '2024a',
        wall_time: '2026-10-17 09:20',
        fold: 0,
        resolved_utc_offset_seconds: 28800,
        frozen: true,
        state: 'cancel_pending',
      });
    });
  });

  it('terminal disconnects and assistant-audit failures cannot append a second terminal', async () => {
    await withApi(pool, async (_base, _deps, ownerId) => {
      for (const fault of ['return_false', 'writer_throw', 'assistant_audit'] as const) {
        const key = randomUUID();
        const started = await startConversationRun(
          { pool, timeContext: healthy },
          ownerId,
          randomUUID(),
          proposal,
          key,
        );
        if (!started.context) throw new Error('new run required');
        const faultName = `fail_assistant_${key.replaceAll('-', '')}`;
        if (fault === 'assistant_audit') {
          await pool.query(`
            CREATE FUNCTION ${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'assistant audit unavailable'; END $$;
            CREATE TRIGGER ${faultName} BEFORE INSERT ON messages
            FOR EACH ROW WHEN (NEW.owner_id='${ownerId}'::uuid AND NEW.role='assistant')
            EXECUTE FUNCTION ${faultName}();
          `);
        }
        try {
          await executeRun({ pool, timeContext: healthy }, started.context, async (event) => {
            if (event.type === 'thread.failed' && fault === 'writer_throw')
              throw new Error('socket gone after terminal checkpoint');
            return event.type !== 'thread.failed' || fault !== 'return_false';
          });
        } finally {
          if (fault === 'assistant_audit') {
            await pool.query(
              `DROP TRIGGER ${faultName} ON messages; DROP FUNCTION ${faultName}();`,
            );
          }
        }
        const events = await listRunEvents(pool, ownerId, started.runId);
        expect(events.map((event) => event.type)).toEqual(['thread.started', 'thread.failed']);
        expect(events.at(-1)).toMatchObject({
          payload: { error: { code: 'AMBIGUOUS_LOCAL_TIME' } },
        });
        const replay = await startConversationRun(
          { pool, timeContext: unavailable },
          ownerId,
          randomUUID(),
          proposal,
          key,
        );
        expect(replay.replay).toEqual(events);
      }
    });
  });
  it('first/second HTTP re-proposals freeze the selected occurrence, UTC and offset without confirming or moving the conversation anchor', async () => {
    await withApi(pool, async (base, deps, ownerId) => {
      const key = randomUUID();
      const original = await post(base, proposal, key);
      const failed = frames(await original.text());
      const conversationId = failed[0].payload.conversation_id;
      const { rows: before } = await pool.query(
        'SELECT anchor_received_at_utc FROM conversations WHERE id = $1',
        [conversationId],
      );
      for (const [fold_choice, utc, offset, fold] of [
        ['first', '2026-11-01T05:30:00.000Z', -14400, 0],
        ['second', '2026-11-01T06:30:00.000Z', -18000, 1],
      ] as const) {
        const body = { ...proposal, conversation_id: conversationId, fold_choice };
        expect((await post(base, body, key)).status).toBe(409);
        const response = await post(base, body);
        expect(response.status).toBe(200);
        const events = frames(await response.text());
        expect(events.at(-1)?.type).toBe('thread.completed');
        const required = events.find((event) => event.type === 'approval_required');
        if (required?.type !== 'approval_required') throw new Error('pending approval missing');
        const occurrence = fold === 0 ? '第一次出现' : '第二次出现';
        const frozenOffset = fold === 0 ? 'UTC-04:00' : 'UTC-05:00';
        const message = events
          .filter((event) => event.type === 'message.delta')
          .map((event) => event.payload.delta)
          .join('');
        expect(message).toContain(occurrence);
        expect(message).toContain(frozenOffset);
        deps.timeContext = unavailable;
        const detailResponse = await fetch(
          `${base}/api/v1/approvals/${required.payload.approval_id}`,
        );
        expect(detailResponse.status).toBe(200);
        const detail = (await detailResponse.json()) as { data: { echo_text: string } };
        expect(detail.data.echo_text).toContain(occurrence);
        expect(detail.data.echo_text).toContain(frozenOffset);
        deps.timeContext = healthy;
        const { rows } = await pool.query(
          'SELECT state, timezone_id, fold, resolved_utc_offset_seconds, fire_at_utc FROM approvals WHERE id = $1',
          [required.payload.approval_id],
        );
        expect(rows[0]).toMatchObject({
          state: 'pending',
          timezone_id: 'America/New_York',
          fold,
          resolved_utc_offset_seconds: offset,
        });
        expect((rows[0].fire_at_utc as Date).toISOString()).toBe(utc);
      }
      const { rows: after } = await pool.query(
        'SELECT anchor_received_at_utc FROM conversations WHERE id = $1',
        [conversationId],
      );
      expect(after).toEqual(before);
      const actual = await counts(pool, ownerId);
      expect(actual.approvals).toBe(2);
      for (const table of ['tasks', 'task_events', 'outbox', 'notifications'])
        expect(actual[table]).toBe(0);
    });
  });

  it('bad rules do not globally reject new read-only conversation turns', async () => {
    await withApi(pool, async (base, deps) => {
      deps.timeContext = unavailable;
      const readOnly = await post(base, { raw_text: '你好' });
      expect(readOnly.status).toBe(200);
      expect(frames(await readOnly.text()).at(-1)).toMatchObject({
        type: 'thread.completed',
        payload: { approval_id: null },
      });
    });
  });
});
