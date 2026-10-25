import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ThreadEventSchema, type ThreadEvent } from '@along/stream-protocol';
import { handleRequest } from '../../src/http/app.js';
import { seedSession } from '../../src/modules/identity/seed.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const Detail = z.object({
  data: z.object({
    approval_id: z.string().uuid(),
    echo_text: z.string(),
    presentation_hash: z.string(),
    presentation_version: z.string(),
    expires_at: z.string(),
    snapshot: z.object({ timezone_id: z.string() }),
  }),
});
const Confirmed = z.object({
  data: z.object({ task_id: z.string().uuid(), status: z.literal('consumed') }),
});
const Conversation = z.object({ data: z.object({ events: z.array(ThreadEventSchema) }) });

function frames(text: string): ThreadEvent[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => ThreadEventSchema.parse(JSON.parse(line.slice(6))));
}
function required(events: ThreadEvent[]) {
  const event = events.find((event) => event.type === 'approval_required');
  if (!event || event.type !== 'approval_required') throw new Error('approval_required missing');
  return event;
}

maybe('tool invocation boundary on signed HTTP and persisted SSE', () => {
  let database: IntegrationDatabase;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    server = createServer((req, res) => {
      void handleRequest(req, res, { pool: database.pool, tzdbVersion: 'fixture-v1' }).catch(() =>
        res.destroy(),
      );
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP address unavailable');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    if (server) {
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
    }
    await database?.close();
  });

  async function actor() {
    const session = await seedSession(database.pool, {});
    return {
      session,
      headers: {
        cookie: `better-auth.session_token=${session.token}`,
        'x-csrf-token': session.csrfToken,
      },
    };
  }
  function post(path: string, body: unknown, headers: Record<string, string>) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }
  async function confirm(approvalId: string, headers: Record<string, string>) {
    const response = await fetch(`${base}/api/v1/approvals/${approvalId}`, { headers });
    expect(response.status).toBe(200);
    const detail = Detail.parse(await response.json()).data;
    const body = {
      presentation_hash: detail.presentation_hash,
      seen_content: detail.echo_text,
      idempotency_key: randomUUID(),
    };
    const result = await post(`/api/v1/approvals/${approvalId}/actions/confirm`, body, headers);
    expect(result.status).toBe(200);
    return { detail, body, result: Confirmed.parse(await result.json()).data };
  }

  it('runs a real proposal, freezes its button, replays POST/GET without tools, then confirms a cancellation', async () => {
    const { session, headers } = await actor();
    const body = {
      raw_text: '2026-11-02 09:20 提醒我喝水',
      confirmed_timezone: 'Asia/Shanghai',
      idempotency_key: randomUUID(),
    };
    const csrf = await post('/api/v1/conversations/messages', body, { cookie: headers.cookie });
    expect(csrf.status).toBe(403);
    const response = await post('/api/v1/conversations/messages', body, headers);
    expect(response.status).toBe(200);
    const events = frames(await response.text());
    expect(events.map((event) => event.type)).toEqual([
      'thread.started',
      'message.delta',
      'card.proposed',
      'approval_required',
      'thread.completed',
    ]);
    const approvalEvent = required(events);
    const approvalId = approvalEvent.payload.approval_id;
    const conversationId = approvalEvent.payload.conversation_id;
    const approved = await confirm(approvalId, headers);
    expect(approved.detail.presentation_hash).toBe(approvalEvent.payload.presentation_hash);
    expect(approved.detail.snapshot.timezone_id).toBe('Asia/Shanghai');
    const repeatConfirm = await post(
      `/api/v1/approvals/${approvalId}/actions/confirm`,
      approved.body,
      headers,
    );
    expect(repeatConfirm.status).toBe(200);
    expect(Confirmed.parse(await repeatConfirm.json()).data.task_id).toBe(approved.result.task_id);
    const replay = await post('/api/v1/conversations/messages', body, headers);
    expect(replay.status).toBe(200);
    expect(frames(await replay.text())).toEqual(events);
    const after = await fetch(
      `${base}/api/v1/conversations/${conversationId}?after_seq=${events[0]!.seq}&limit=100`,
      { headers },
    );
    expect(after.status).toBe(200);
    expect(Conversation.parse(await after.json()).data.events).toEqual(events.slice(1));
    const accepted = await database.pool.query(
      'SELECT tool_id,state,outcome_kind,approval_id FROM tool_invocations WHERE owner_id=$1',
      [session.userId],
    );
    expect(accepted.rows).toEqual([
      {
        tool_id: 'propose_task',
        state: 'completed',
        outcome_kind: 'approval_pending',
        approval_id: approvalId,
      },
    ]);
    const cancelResponse = await post(
      '/api/v1/conversations/messages',
      {
        raw_text: `取消 ${approved.result.task_id}`,
        conversation_id: conversationId,
        idempotency_key: randomUUID(),
      },
      headers,
    );
    expect(cancelResponse.status).toBe(200);
    const cancelEvents = frames(await cancelResponse.text());
    const cancelled = await confirm(required(cancelEvents).payload.approval_id, headers);
    expect(cancelled.result.task_id).toBe(approved.result.task_id);
    const task = await database.pool.query('SELECT state,schedule_receipt FROM tasks WHERE id=$1', [
      approved.result.task_id,
    ]);
    expect(task.rows[0]).toEqual({ state: 'cancel_pending', schedule_receipt: null });
    const history = await database.pool.query<{ type: string }>(
      'SELECT type FROM task_events WHERE task_id=$1',
      [approved.result.task_id],
    );
    expect(history.rows.map((row) => row.type).sort()).toEqual(['cancel_requested', 'created']);
    const counts = await database.pool.query(
      'SELECT count(*)::int AS n FROM tool_invocations WHERE owner_id=$1',
      [session.userId],
    );
    expect(counts.rows[0]?.n).toBe(2);
  });

  for (const fault of ['audit', 'checkpoint'] as const) {
    it(`${fault} failure ends HTTP SSE once and POST replay does not execute tools again`, async () => {
      const { session, headers } = await actor();
      const fn = `fail_${fault}_${session.userId.replaceAll('-', '')}`;
      const table = fault === 'audit' ? 'tool_calls' : 'run_checkpoints';
      const condition = fault === 'audit' ? '' : " AND NEW.kind='card.proposed'";
      await database.pool.query(`
        CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture output persistence fault'; END $$;
        CREATE TRIGGER ${fn} BEFORE INSERT ON ${table} FOR EACH ROW
        WHEN (NEW.owner_id='${session.userId}'::uuid${condition}) EXECUTE FUNCTION ${fn}();
      `);
      const body = {
        raw_text: '2026-11-02 09:20 提醒我喝水',
        confirmed_timezone: 'Asia/Shanghai',
        idempotency_key: randomUUID(),
      };
      let events: ThreadEvent[];
      try {
        const response = await post('/api/v1/conversations/messages', body, headers);
        expect(response.status).toBe(200);
        events = frames(await response.text());
        expect(
          events
            .filter((event) =>
              ['thread.failed', 'thread.completed', 'thread.cancelled'].includes(event.type),
            )
            .map((event) => event.type),
        ).toEqual(['thread.failed']);
        expect(events.some((event) => event.type === 'approval_required')).toBe(false);
      } finally {
        await database.pool.query(`DROP TRIGGER ${fn} ON ${table}; DROP FUNCTION ${fn}();`);
      }
      const replay = await post('/api/v1/conversations/messages', body, headers);
      expect(replay.status).toBe(200);
      expect(frames(await replay.text())).toEqual(events);
      const ledger = await database.pool.query(
        'SELECT state,approval_id FROM tool_invocations WHERE owner_id=$1',
        [session.userId],
      );
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0]?.state).toBe(fault === 'audit' ? 'reserved' : 'completed');
      const counts = await database.pool.query(
        `SELECT
        (SELECT count(*)::int FROM approvals WHERE owner_id=$1) AS approvals,
        (SELECT count(*)::int FROM tool_calls WHERE owner_id=$1) AS calls,
        (SELECT count(*)::int FROM tasks WHERE owner_id=$1) AS tasks,
        (SELECT count(*)::int FROM task_events WHERE owner_id=$1) AS events,
        (SELECT count(*)::int FROM outbox WHERE owner_id=$1) AS outbox,
        (SELECT count(*)::int FROM notifications WHERE owner_id=$1) AS notifications`,
        [session.userId],
      );
      expect(counts.rows[0]).toEqual({
        approvals: fault === 'audit' ? 0 : 1,
        calls: fault === 'audit' ? 0 : 1,
        tasks: 0,
        events: 0,
        outbox: 0,
        notifications: 0,
      });
      if (fault === 'checkpoint') {
        const detail = await fetch(`${base}/api/v1/approvals/${ledger.rows[0]?.approval_id}`, {
          headers,
        });
        expect(detail.status).toBe(200);
        expect(Detail.parse(await detail.json()).data.approval_id).toBe(
          ledger.rows[0]?.approval_id,
        );
      }
    });
  }
});
