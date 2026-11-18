import { admitTestUser } from './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ApprovalDetailSchema, EnvelopeSchema } from '@along/contracts';
import { createServer, type Server } from 'node:http';
import type { Pool } from 'pg';
import { handleRequest } from '../helpers/http-app.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import { frames, listen, pending, started } from '../helpers/harness-consumer.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const suite = databaseUrl ? describe : describe.skip;
suite('request-owned reminder date anchors through HTTP and PostgreSQL', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  let server: Server;
  let base: string;
  let ownerId: string;
  const timeContext = loadTimeContext('fixture-v1');
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
    // Deterministic server clock inside this file's isolated schema only.
    // All messages, immutable Run inputs and real tool transactions still use PG.
    await pool.query(`CREATE TABLE test_clock (at timestamptz NOT NULL);
      INSERT INTO test_clock VALUES ('2026-11-01T02:00:00Z');
      CREATE FUNCTION clock_timestamp() RETURNS timestamptz LANGUAGE sql AS
      'SELECT at FROM test_clock';`);
    server = createServer(
      (req, res) =>
        void handleRequest(req, res, {
          pool,
          timeContext,
          tzdbVersion: 'fixture-v1',
          resolveActor: async () => ({
            ownerId,
            sessionId: null,
            displayName: 'date tester',
            timezoneId: null,
          }),
        }),
    );
    base = await listen(server);
  });
  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await database?.close();
  });
  async function actor() {
    ownerId = randomUUID();
    await pool.query("INSERT INTO users(id,auth_email,display_name) VALUES($1,$2,'date tester')", [
      ownerId,
      `${ownerId}@along.test`,
    ]);
    await admitTestUser(pool, ownerId);
  }
  async function at(time: string) {
    await pool.query('UPDATE test_clock SET at=$1', [time]);
  }
  async function send(raw_text: string, body: Record<string, unknown> = {}, key = randomUUID()) {
    const response = await fetch(`${base}/api/v1/conversations/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ raw_text, ...body }),
    });
    expect(response.status).toBe(200);
    return frames(await response.text());
  }
  async function approval(id: string) {
    return (
      await pool.query(
        'SELECT wall_time,fire_at_utc,timezone_id,fold,presentation_hash FROM approvals WHERE id=$1',
        [id],
      )
    ).rows[0];
  }
  async function frozen(id: string) {
    return (await pool.query('SELECT frozen_context FROM agent_runs WHERE id=$1', [id])).rows[0]
      .frozen_context;
  }
  async function noCommitments() {
    for (const table of ['approvals', 'tasks', 'task_events', 'outbox']) {
      expect(
        (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id=$1`, [ownerId]))
          .rows[0].n,
      ).toBe(0);
    }
  }

  it('new today and tomorrow use each accepted turn, not an old conversation clock', async () => {
    await actor();
    await at('2026-10-30T02:00:00Z');
    const first = started(await send('查看提醒'));
    await at('2026-11-01T02:00:00Z');
    const today = await send('今天15:20提醒我喝水', {
      conversation_id: first.conversation_id,
      confirmed_timezone: 'Asia/Shanghai',
    });
    expect(await approval(pending(today))).toMatchObject({
      wall_time: '2026-11-01 15:20',
      timezone_id: 'Asia/Shanghai',
    });
    await at('2026-11-02T02:00:00Z');
    const tomorrow = await send('明天15:20提醒我买水', { conversation_id: first.conversation_id });
    expect(await approval(pending(tomorrow))).toMatchObject({ wall_time: '2026-11-03 15:20' });
    expect((await frozen(started(today).run_id)).anchorReceivedAtUtc).toBe('2026-11-01T02:00:00Z');
    expect(
      (
        await pool.query('SELECT anchor_received_at_utc FROM conversations WHERE id=$1', [
          first.conversation_id,
        ])
      ).rows[0].anchor_received_at_utc.toISOString(),
    ).toBe('2026-10-30T02:00:00.000Z');
  });

  it('a unique actual timezone clarification keeps its original date after 120 seconds', async () => {
    await actor();
    await at('2026-11-01T02:00:00Z');
    const first = started(await send('今天15:20提醒我喝水'));
    await noCommitments();
    const before = await frozen(first.run_id);
    await at('2026-11-01T02:02:00Z');
    const answer = await send('北京时间', { conversation_id: first.conversation_id });
    expect(await approval(pending(answer))).toMatchObject({ wall_time: '2026-11-01 15:20' });
    expect(await frozen(first.run_id)).toEqual(before);
    expect(await frozen(started(answer).run_id)).toMatchObject({
      anchorReceivedAtUtc: '2026-11-01T02:00:00Z',
      receivedAtUtc: '2026-11-01T02:02:00Z',
      reminderDateSource: { kind: 'clarification', sourceRunId: first.run_id },
    });
  });

  it('a timezone clarification crossing local midnight in 20 seconds asks for a date', async () => {
    await actor();
    await at('2026-11-01T15:59:50Z');
    const first = started(await send('明天15:20提醒我喝水'));
    await at('2026-11-01T16:00:10Z');
    const answer = await send('Asia/Shanghai', { conversation_id: first.conversation_id });
    expect(answer.some((event) => event.type === 'approval_required')).toBe(false);
    const result = (
      await pool.query('SELECT accepted_result FROM tool_invocations WHERE run_id=$1', [
        started(answer).run_id,
      ])
    ).rows[0].accepted_result;
    expect(result).toMatchObject({
      status: 'ok',
      result: { kind: 'clarify', reason: 'DATE_CHANGED' },
    });
    await noCommitments();
  });

  for (const kind of ['multiple', 'intervening', 'legacy', 'already-proposed'] as const) {
    it(`does not infer a source for ${kind} reminders`, async () => {
      await actor();
      await at('2026-11-01T02:00:00Z');
      let first;
      if (kind === 'legacy') {
        // A legitimate pre-cutover Run has no versioned source; never backfill it.
        const conversationId = randomUUID(),
          messageId = randomUUID(),
          runId = randomUUID();
        await pool.query(
          `INSERT INTO conversations(id,owner_id,anchor_received_at_utc) VALUES($1,$2,'2026-10-30T02:00:00Z');`,
          [conversationId, ownerId],
        );
        await pool.query(
          `INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','明天15:20提醒我喝水')`,
          [messageId, ownerId, conversationId],
        );
        await pool.query(
          `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
          VALUES($1,$2,$3,'assistant/r1','task','done',10,8000,'business','[]','{}',$4)`,
          [runId, ownerId, conversationId, messageId],
        );
        first = { conversation_id: conversationId, run_id: runId };
      } else {
        first = started(
          await send(
            '明天15:20提醒我喝水',
            kind === 'already-proposed' ? { confirmed_timezone: 'Asia/Shanghai' } : {},
          ),
        );
        await at('2026-11-01T02:00:10Z');
        if (kind === 'multiple')
          await send('明天16:20提醒我买水', { conversation_id: first.conversation_id });
        if (kind === 'intervening')
          await send('查看提醒', { conversation_id: first.conversation_id });
      }
      await at('2026-11-01T02:02:00Z');
      const before = (
        await pool.query('SELECT count(*)::int n FROM approvals WHERE owner_id=$1', [ownerId])
      ).rows[0].n;
      const answer = await send('北京时间', { conversation_id: first.conversation_id });
      expect(answer.some((event) => event.type === 'approval_required')).toBe(false);
      expect((await frozen(started(answer).run_id)).reminderDateSource.kind).toBe('unresolved');
      expect(
        (await pool.query('SELECT count(*)::int n FROM approvals WHERE owner_id=$1', [ownerId]))
          .rows[0].n,
      ).toBe(before);
    });
  }

  it('message replay and history after midnight do not reinterpret frozen proposals', async () => {
    await actor();
    await at('2026-11-01T02:00:00Z');
    const key = randomUUID();
    const body = { confirmed_timezone: 'Asia/Shanghai' };
    const original = await send('明天15:20提醒我喝水', body, key);
    const identity = started(original),
      approvalId = pending(original);
    const frozenApproval = await approval(approvalId),
      frozenRun = await frozen(identity.run_id);
    await at('2026-11-02T02:00:00Z');
    expect(await send('明天15:20提醒我喝水', body, key)).toEqual(original);
    const history = await fetch(`${base}/api/v1/conversations/${identity.conversation_id}`);
    expect(history.status).toBe(200);
    await history.json();
    expect(await approval(approvalId)).toEqual(frozenApproval);
    expect(await frozen(identity.run_id)).toEqual(frozenRun);
    expect(
      (await pool.query('SELECT count(*)::int n FROM agent_runs WHERE owner_id=$1', [ownerId]))
        .rows[0].n,
    ).toBe(1);
  });

  for (const mode of [
    'same-day',
    'midnight',
    'missing-reference',
    'wrong-timezone',
    'wrong-reference',
  ] as const) {
    it(`keeps fold candidate ownership for ${mode} re-proposals`, async () => {
      await actor();
      await at('2026-11-01T04:59:50Z');
      const text = '今天01:30提醒我喝水';
      const first = started(await send(text, { confirmed_timezone: 'America/New_York' }));
      await at(mode === 'midnight' ? '2026-11-02T05:00:10Z' : '2026-11-01T05:02:00Z');
      const body = {
        conversation_id: first.conversation_id,
        confirmed_timezone: mode === 'wrong-timezone' ? 'Asia/Shanghai' : 'America/New_York',
        fold_choice: 'first',
        ...(mode === 'missing-reference'
          ? {}
          : {
              clarification_of_run_id: mode === 'wrong-reference' ? randomUUID() : first.run_id,
            }),
      };
      const answer = await send(text, body);
      if (mode === 'same-day') {
        expect(await approval(pending(answer))).toMatchObject({
          wall_time: '2026-11-01 01:30',
          fold: 0,
          timezone_id: 'America/New_York',
          fire_at_utc: new Date('2026-11-01T05:30:00Z'),
        });
        expect((await frozen(started(answer).run_id)).anchorReceivedAtUtc).toBe(
          '2026-11-01T04:59:50Z',
        );
        const conflicting = await fetch(`${base}/api/v1/conversations/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ raw_text: text, ...body, idempotency_key: randomUUID() }),
        });
        expect(conflicting.status).toBe(200);
        expect(
          frames(await conflicting.text()).some((event) => event.type === 'approval_required'),
        ).toBe(false);
      } else {
        expect(answer.some((event) => event.type === 'approval_required')).toBe(false);
        await noCommitments();
      }
    });
  }

  it('removing the delay threshold does not authorize confirming an elapsed target', async () => {
    await actor();
    await at('2026-11-01T02:00:00Z');
    const first = started(await send('今天10:01提醒我喝水'));
    await at('2026-11-01T02:02:00Z');
    const proposed = await send('北京时间', { conversation_id: first.conversation_id });
    const id = pending(proposed);
    const detail = ApprovalDetailSchema.parse(
      EnvelopeSchema.parse(await (await fetch(`${base}/api/v1/approvals/${id}`)).json()).data,
    );
    const response = await fetch(`${base}/api/v1/approvals/${id}/actions/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        presentation_hash: detail.presentation_hash,
        seen_content: detail.echo_text,
        idempotency_key: randomUUID(),
      }),
    });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: 'APPROVAL_EXPIRED' } });
    expect(
      (await pool.query('SELECT count(*)::int n FROM tasks WHERE owner_id=$1', [ownerId])).rows[0]
        .n,
    ).toBe(0);
  });

  it('model-supplied old dates or invented clocks cannot fill missing user fields', async () => {
    await actor();
    await at('2026-11-01T02:00:00Z');
    for (const raw_text of ['15:20提醒我喝水', '明天提醒我喝水']) {
      const run = await startConversationRun(
        { pool, timeContext },
        ownerId,
        randomUUID(),
        { raw_text, confirmed_timezone: 'Asia/Shanghai' },
        randomUUID(),
      );
      if (!run.context) throw new Error('fresh Run missing');
      const ctx = run.context;
      const args = { raw_time_text: '明天15:20', note: '喝水', occurrence: 'once' };
      const reservation = await reserveToolInvocation(pool, ctx, {
        callKey: 'fabricated/1',
        toolId: 'propose_task',
        args,
      });
      const result = await invokeTool(pool, ctx, { ...reservation, toolId: 'propose_task', args });
      expect(result).toMatchObject({ status: 'ok', result: { kind: 'clarify' } });
    }
    await noCommitments();
  });
});
