// Issue #9: conversation SSE contract — deterministic triage, approval
// cards, typed time failures, budget, idempotent replay,
// after_seq cursor, disconnect cancellation, cancel approvals via tool call.
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { ThreadEventSchema, type ThreadEvent } from '@along/stream-protocol';
import { handleConversationRoute } from '../../src/modules/conversations/routes.js';
import {
  executeRun,
  getConversationDetail,
  startConversationRun,
} from '../../src/modules/conversations/service.js';
import type { StartResult } from '../../src/modules/conversations/contracts.js';
import { listRunEvents } from '../../src/modules/conversations/repository.js';
import { invokeTool, reserveToolInvocation } from '../../src/modules/tools/gateway.js';
import { confirmApproval } from '../../src/modules/approvals/confirm.js';
import { getApprovalDetail } from '../../src/modules/approvals/service.js';
import { getTaskDetail } from '../../src/modules/tasks/service.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  type IntegrationDatabase,
  seedApproval,
} from './setup.js';
import { loadTimeContext } from '../../src/modules/time/context.js';

const timeContext = loadTimeContext('fixture-v1');

const maybe = databaseUrl ? describe : describe.skip;

class CapturedResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  writableEnded = false;
  destroyed = false;
  constructor(private readonly frames: string[]) {
    super();
  }
  flushHeaders() {}
  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
  }
  write(chunk: string) {
    this.frames.push(chunk);
    return true;
  }
  end() {
    this.writableEnded = true;
  }
}

async function seedUser(pool: Pool): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, auth_email, display_name, timezone_id)
     VALUES ($1, $2, 'tester', 'Asia/Shanghai')`,
    [id, `tester-${id}@along.test`],
  );
  return id;
}

async function collect(
  pool: Pool,
  started: StartResult,
  stopAfter = Number.POSITIVE_INFINITY,
): Promise<ThreadEvent[]> {
  const events: ThreadEvent[] = [];
  if (!started.context) throw new Error('expected a fresh run');
  await executeRun({ pool, timeContext }, started.context, async (event) => {
    events.push(event);
    return events.length < stopAfter;
  });
  return events;
}

maybe('conversation runtime', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await database?.close();
  });

  it('reminder path proposes an approval card and never creates a task', async () => {
    const ownerId = await seedUser(pool);
    const started = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      { raw_text: '明天 9:20 提醒我喝水', confirmed_timezone: 'Asia/Shanghai' },
      randomUUID(),
    );
    expect(started.replay).toBeNull();
    const events = await collect(pool, started);
    expect(events.map((e) => e.type)).toEqual([
      'thread.started',
      'message.delta',
      'card.proposed',
      'approval_required',
      'thread.completed',
    ]);
    const approval = events.find((e) => e.type === 'approval_required');
    if (!approval || approval.type !== 'approval_required') {
      throw new Error('approval_required missing');
    }
    const { rows } = await pool.query(
      'SELECT kind, state, conversation_id, target_task_id FROM approvals WHERE id = $1',
      [approval.payload.approval_id],
    );
    expect(rows[0]).toMatchObject({
      kind: 'create_task',
      state: 'pending',
      conversation_id: started.conversationId,
      target_task_id: null,
    });
    const { rows: tasks } = await pool.query(
      'SELECT count(*)::int AS n FROM tasks WHERE owner_id = $1',
      [ownerId],
    );
    expect(tasks[0]?.n).toBe(0);
    const { rows: calls } = await pool.query(
      'SELECT tool_id, decision FROM tool_calls WHERE run_id = $1',
      [started.runId],
    );
    expect(calls).toEqual([{ tool_id: 'propose_task', decision: 'allow' }]);
    const { rows: runs } = await pool.query('SELECT status FROM agent_runs WHERE id = $1', [
      started.runId,
    ]);
    expect(runs[0]?.status).toBe('done');
    const { rows: messages } = await pool.query(
      'SELECT role FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [started.conversationId],
    );
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('missing date/time clarifies instead of failing', async () => {
    const ownerId = await seedUser(pool);
    const started = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      { raw_text: '提醒我喝水', confirmed_timezone: 'Asia/Shanghai' },
      randomUUID(),
    );
    const events = await collect(pool, started);
    expect(events.map((e) => e.type)).toEqual([
      'thread.started',
      'message.delta',
      'thread.completed',
    ]);
    const completed = events[2];
    if (!completed || completed.type !== 'thread.completed') {
      throw new Error('thread.completed missing');
    }
    expect(completed.payload.approval_id).toBeNull();
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM approvals WHERE owner_id = $1',
      [ownerId],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('ambiguous local time fails with ordered structured candidates and no approval', async () => {
    const ownerId = await seedUser(pool);
    const started = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      { raw_text: '2026-11-01 01:30 提醒我喝水', confirmed_timezone: 'America/New_York' },
      randomUUID(),
    );
    const events = await collect(pool, started);
    expect(events.map((e) => e.type)).toEqual(['thread.started', 'thread.failed']);
    expect(events[1]).toMatchObject({
      type: 'thread.failed',
      payload: {
        error: {
          code: 'AMBIGUOUS_LOCAL_TIME',
          http_status: 422,
          details: {
            wall_time: '2026-11-01T01:30:00',
            timezone_id: 'America/New_York',
            ruleset_id: 'FIXTURE_V1',
            candidates: [
              { fold_choice: 'first', offset_seconds: -14400, fire_at_utc: '2026-11-01T05:30:00Z' },
              {
                fold_choice: 'second',
                offset_seconds: -18000,
                fire_at_utc: '2026-11-01T06:30:00Z',
              },
            ],
          },
        },
      },
    });
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM approvals WHERE owner_id = $1',
      [ownerId],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('nonexistent local time fails without creating an approval', async () => {
    const ownerId = await seedUser(pool);
    const started = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      { raw_text: '2027-03-14 02:30 提醒我喝水', confirmed_timezone: 'America/New_York' },
      randomUUID(),
    );
    const events = await collect(pool, started);
    expect(events.map((e) => e.type)).toEqual(['thread.started', 'thread.failed']);
    expect(events[1]).toMatchObject({
      type: 'thread.failed',
      payload: { error: { code: 'NONEXISTENT_LOCAL_TIME', http_status: 422 } },
    });
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM approvals WHERE owner_id = $1',
      [ownerId],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('fold_choice=first resolves an ambiguous wall time into an approval', async () => {
    const ownerId = await seedUser(pool);
    const started = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      {
        raw_text: '2026-11-01 01:30 提醒我喝水',
        confirmed_timezone: 'America/New_York',
        fold_choice: 'first',
      },
      randomUUID(),
    );
    const events = await collect(pool, started);
    expect(events.map((e) => e.type)).toEqual([
      'thread.started',
      'message.delta',
      'card.proposed',
      'approval_required',
      'thread.completed',
    ]);
    const approval = events.find((e) => e.type === 'approval_required');
    if (!approval || approval.type !== 'approval_required') {
      throw new Error('approval_required missing');
    }
    const { rows } = await pool.query(
      'SELECT fold, resolved_utc_offset_seconds FROM approvals WHERE id = $1',
      [approval.payload.approval_id],
    );
    expect(rows[0]).toMatchObject({ fold: 0, resolved_utc_offset_seconds: -14400 });
  });

  it('fold_choice=second uses the second-occurrence echo and confirms', async () => {
    const ownerId = await seedUser(pool);
    const started = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      {
        raw_text: '2027-11-07 01:30 提醒我喝水',
        confirmed_timezone: 'America/New_York',
        fold_choice: 'second',
      },
      randomUUID(),
    );
    const events = await collect(pool, started);
    const delta = events.find((e) => e.type === 'message.delta');
    if (!delta || delta.type !== 'message.delta') {
      throw new Error('message.delta missing');
    }
    expect(delta.payload.delta).toContain('第二次');
    const required = events.find((e) => e.type === 'approval_required');
    if (!required || required.type !== 'approval_required') {
      throw new Error('approval_required missing');
    }
    const { rows } = await pool.query(
      'SELECT fold, resolved_utc_offset_seconds FROM approvals WHERE id = $1',
      [required.payload.approval_id],
    );
    expect(rows[0]).toMatchObject({ fold: 1, resolved_utc_offset_seconds: -18000 });

    const detail = await getApprovalDetail({ pool }, ownerId, required.payload.approval_id);
    const confirmed = await confirmApproval({ pool }, ownerId, required.payload.approval_id, {
      presentation_hash: detail.detail.presentation_hash,
      seen_content: detail.detail.echo_text,
      idempotency_key: randomUUID(),
    });
    expect(confirmed.duplicate).toBe(false);
  });

  it('long business input follows deterministic clarification without estimating model usage', async () => {
    const ownerId = await seedUser(pool);
    const started = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      { raw_text: `你好${'水'.repeat(8000)}`, confirmed_timezone: 'Asia/Shanghai' },
      randomUUID(),
    );
    const events = await collect(pool, started);
    expect(events.map((e) => e.type)).toEqual([
      'thread.started',
      'message.delta',
      'thread.completed',
    ]);
    const { rows } = await pool.query('SELECT status FROM agent_runs WHERE id = $1', [
      started.runId,
    ]);
    expect(rows[0]?.status).toBe('done');
  });

  it('same Idempotency-Key replays the stored events; a changed body is 409', async () => {
    const ownerId = await seedUser(pool);
    const key = randomUUID();
    const body = { raw_text: '明天 9:20 提醒我喝水', confirmed_timezone: 'Asia/Shanghai' };
    const first = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      body,
      key,
    );
    const firstEvents = await collect(pool, first);
    const replay = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      body,
      key,
    );
    expect(replay.replay).toEqual(firstEvents);
    const mismatch = startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      { ...body, raw_text: '明天 10:20 提醒我喝水' },
      key,
    );
    await expect(mismatch).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('an expired idempotency key starts a fresh run instead of colliding', async () => {
    const ownerId = await seedUser(pool);
    const key = randomUUID();
    const body = { raw_text: '明天 9:20 提醒我喝水', confirmed_timezone: 'Asia/Shanghai' };
    const first = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      body,
      key,
    );
    await pool.query(
      "UPDATE conversation_idempotency SET expires_at = now() - interval '1 hour' WHERE owner_id = $1 AND idempotency_key = $2",
      [ownerId, key],
    );
    const second = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      body,
      key,
    );
    expect(second.replay).toBeNull();
    expect(second.runId).not.toBe(first.runId);
    expect(second.conversationId).not.toBe(first.conversationId);
  });

  it('concurrent requests with one key create a single run; the loser gets 409', async () => {
    const ownerId = await seedUser(pool);
    const key = randomUUID();
    const body = { raw_text: '明天 9:20 提醒我喝水', confirmed_timezone: 'Asia/Shanghai' };
    const settled = await Promise.allSettled([
      startConversationRun({ pool, timeContext }, ownerId, randomUUID(), body, key),
      startConversationRun({ pool, timeContext }, ownerId, randomUUID(), body, key),
    ]);
    const winners = settled.filter(
      (entry): entry is PromiseFulfilledResult<StartResult> => entry.status === 'fulfilled',
    );
    expect(winners).toHaveLength(1);
    const loser = settled.find((entry) => entry.status === 'rejected');
    if (!loser || loser.status !== 'rejected') throw new Error('expected one loser');
    expect(loser.reason).toMatchObject({ httpStatus: 409 });

    const winner = winners[0];
    if (!winner) throw new Error('expected one winner');
    const events = await collect(pool, winner.value);
    expect(events.at(-1)?.type).toBe('thread.completed');
    const replay = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      body,
      key,
    );
    expect(replay.replay).toEqual(events);
  });

  it('retrying while the original run is still running returns 409', async () => {
    const ownerId = await seedUser(pool);
    const key = randomUUID();
    const body = { raw_text: '明天 9:20 提醒我喝水', confirmed_timezone: 'Asia/Shanghai' };
    const first = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      body,
      key,
    );
    const retry = startConversationRun({ pool, timeContext }, ownerId, randomUUID(), body, key);
    await expect(retry).rejects.toMatchObject({ httpStatus: 409 });
    const { rows } = await pool.query('SELECT status FROM agent_runs WHERE id = $1', [first.runId]);
    expect(rows[0]?.status).toBe('running');
  });

  it('oversized request ids are replaced before they reach checkpoints', async () => {
    const ownerId = await seedUser(pool);
    const frames: string[] = [];
    const req = {
      method: 'POST',
      url: '/api/v1/conversations/messages',
      headers: { 'x-request-id': 'x'.repeat(300) },
    } as unknown as IncomingMessage;
    const res = new CapturedResponse(frames);
    await handleConversationRoute(
      req,
      res as unknown as ServerResponse,
      new URL(req.url ?? '/', 'http://localhost'),
      {
        pool,
        timeContext,
        resolveActor: async () => ({
          ownerId,
          sessionId: null,
          displayName: 'tester',
          timezoneId: 'Asia/Shanghai',
        }),
        body: { raw_text: '明天 9:20 提醒我喝水', confirmed_timezone: 'Asia/Shanghai' },
      },
    );
    const events = frames
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => ThreadEventSchema.parse(JSON.parse(frame.slice(6))));
    expect(events).toHaveLength(5);
    expect(events[0]?.request_id.length).toBeLessThanOrEqual(200);
  });

  it('reusing a pending cancel approval keeps the stored echo consistent', async () => {
    const ownerId = await seedUser(pool);
    const seed = await seedApproval(pool, { ownerId });
    const detail = await getApprovalDetail({ pool }, ownerId, seed.id);
    const confirmed = await confirmApproval({ pool }, ownerId, seed.id, {
      presentation_hash: seed.presentationHash,
      seen_content: detail.detail.echo_text,
      idempotency_key: randomUUID(),
    });

    const first = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      { raw_text: `取消任务 ${confirmed.task_id}`, confirmed_timezone: 'Asia/Shanghai' },
      randomUUID(),
    );
    const firstEvents = await collect(pool, first);
    const firstRequired = firstEvents.find((e) => e.type === 'approval_required');
    if (!firstRequired || firstRequired.type !== 'approval_required') {
      throw new Error('approval_required missing');
    }

    const second = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      {
        raw_text: `取消任务 ${confirmed.task_id}，我改主意了`,
        confirmed_timezone: 'Asia/Shanghai',
      },
      randomUUID(),
    );
    const secondEvents = await collect(pool, second);
    const secondRequired = secondEvents.find((e) => e.type === 'approval_required');
    if (!secondRequired || secondRequired.type !== 'approval_required') {
      throw new Error('approval_required missing on reuse');
    }
    expect(secondRequired.payload.approval_id).toBe(firstRequired.payload.approval_id);
    const secondDelta = secondEvents.find((e) => e.type === 'message.delta');
    if (!secondDelta || secondDelta.type !== 'message.delta') {
      throw new Error('message.delta missing');
    }
    const stored = await getApprovalDetail({ pool }, ownerId, secondRequired.payload.approval_id);
    expect(secondDelta.payload.delta).toBe(stored.detail.echo_text);

    const result = await confirmApproval({ pool }, ownerId, secondRequired.payload.approval_id, {
      presentation_hash: stored.detail.presentation_hash,
      seen_content: stored.detail.echo_text,
      idempotency_key: randomUUID(),
    });
    expect(result).toMatchObject({ status: 'consumed', task_id: confirmed.task_id });
  });

  it('a writer failure after the stream opens still ends the run as failed', async () => {
    const ownerId = await seedUser(pool);
    const started = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      { raw_text: '明天 9:20 提醒我喝水', confirmed_timezone: 'Asia/Shanghai' },
      randomUUID(),
    );
    if (!started.context) throw new Error('expected fresh run');
    await executeRun({ pool, timeContext }, started.context, async () => {
      const stored = await listRunEvents(pool, ownerId, started.runId);
      if (stored.some((event) => event.type === 'thread.started')) {
        throw new Error('socket gone');
      }
      return true;
    });
    const stored = await listRunEvents(pool, ownerId, started.runId);
    expect(stored.at(-1)?.type).toBe('thread.failed');
    const { rows } = await pool.query('SELECT status FROM agent_runs WHERE id = $1', [
      started.runId,
    ]);
    expect(rows[0]?.status).toBe('failed');
  });

  it('GET after_seq resumes from the global event cursor', async () => {
    const ownerId = await seedUser(pool);
    const started = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      { raw_text: '明天 9:20 提醒我喝水', confirmed_timezone: 'Asia/Shanghai' },
      randomUUID(),
    );
    const events = await collect(pool, started);
    const firstSeq = events[0]?.seq ?? 0;
    const detail = await getConversationDetail(
      { pool, timeContext },
      ownerId,
      started.conversationId,
      {
        after_seq: String(firstSeq),
        limit: '10',
      },
    );
    expect(detail.events).toEqual(events.slice(1));
    expect<number | null | undefined>(detail.next_after_seq).toBe(events.at(-1)?.seq);
  });

  it('disconnect persists thread.cancelled and marks the run cancelled', async () => {
    const ownerId = await seedUser(pool);
    const started = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      { raw_text: '明天 9:20 提醒我喝水', confirmed_timezone: 'Asia/Shanghai' },
      randomUUID(),
    );
    const seen = await collect(pool, started, 1);
    expect(seen.map((e) => e.type)).toEqual(['thread.started']);
    const stored = await listRunEvents(pool, ownerId, started.runId);
    expect(stored.at(-1)?.type).toBe('thread.cancelled');
    const cancelled = stored.at(-1);
    if (cancelled?.type === 'thread.cancelled') {
      expect(cancelled.payload.reason).toBe('client_disconnected');
    }
    const { rows } = await pool.query('SELECT status FROM agent_runs WHERE id = $1', [
      started.runId,
    ]);
    expect(rows[0]?.status).toBe('cancelled');
    const { rows: approvals } = await pool.query(
      'SELECT count(*)::int AS n FROM approvals WHERE owner_id = $1',
      [ownerId],
    );
    expect(approvals[0]?.n).toBe(0);
  });

  it('cancel intent builds a cancel approval and confirm moves the task', async () => {
    const ownerId = await seedUser(pool);
    const seed = await seedApproval(pool, { ownerId });
    const detail = await getApprovalDetail({ pool }, ownerId, seed.id);
    const confirmed = await confirmApproval({ pool }, ownerId, seed.id, {
      presentation_hash: seed.presentationHash,
      seen_content: detail.detail.echo_text,
      idempotency_key: randomUUID(),
    });

    const started = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      { raw_text: `取消任务 ${confirmed.task_id}`, confirmed_timezone: 'Asia/Shanghai' },
      randomUUID(),
    );
    const events = await collect(pool, started);
    expect(events.map((e) => e.type)).toContain('card.proposed');
    const required = events.find((e) => e.type === 'approval_required');
    if (!required || required.type !== 'approval_required') {
      throw new Error('approval_required missing');
    }
    const cancelDetail = await getApprovalDetail({ pool }, ownerId, required.payload.approval_id);
    const result = await confirmApproval({ pool }, ownerId, required.payload.approval_id, {
      presentation_hash: cancelDetail.detail.presentation_hash,
      seen_content: cancelDetail.detail.echo_text,
      idempotency_key: randomUUID(),
    });
    expect(result).toMatchObject({
      approval_id: required.payload.approval_id,
      status: 'consumed',
      task_id: confirmed.task_id,
      duplicate: false,
    });
    const task = await getTaskDetail({ pool }, ownerId, confirmed.task_id);
    expect(task.state).toBe('cancel_pending');

    const again = await confirmApproval({ pool }, ownerId, required.payload.approval_id, {
      presentation_hash: cancelDetail.detail.presentation_hash,
      seen_content: cancelDetail.detail.echo_text,
      idempotency_key: randomUUID(),
    });
    expect(again).toMatchObject({
      status: 'consumed',
      task_id: confirmed.task_id,
      duplicate: true,
    });
  });

  it('gateway denies tools outside the run allowlist and audits the denial', async () => {
    const ownerId = await seedUser(pool);
    const started = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      { raw_text: '你好', confirmed_timezone: 'Asia/Shanghai' },
      randomUUID(),
    );
    if (!started.context) throw new Error('expected a fresh run');
    const ctx = { ...started.context, allowlist: ['list_tasks'] };
    const args = { raw_time_text: '明天 9:20', note: '喝水', occurrence: 'once' };
    const { invocationId } = await reserveToolInvocation(pool, ctx, {
      callKey: 'deny/1',
      toolId: 'propose_task',
      args,
    });
    const outcome = await invokeTool(pool, ctx, { invocationId, toolId: 'propose_task', args });
    expect(outcome.status).toBe('denied');
    const { rows } = await pool.query(
      "SELECT decision, error_code FROM tool_calls WHERE run_id = $1 AND tool_id = 'propose_task'",
      [started.runId],
    );
    expect(rows[0]).toMatchObject({ decision: 'deny', error_code: 'TOOL_DENIED' });
  });

  it('GET route replays history for the owner and hides other owners', async () => {
    const ownerId = await seedUser(pool);
    const started = await startConversationRun(
      { pool, timeContext },
      ownerId,
      randomUUID(),
      { raw_text: '明天 9:20 提醒我喝水', confirmed_timezone: 'Asia/Shanghai' },
      randomUUID(),
    );
    const events = await collect(pool, started);

    const make = (actorId: string) => {
      const req = {
        method: 'GET',
        url: `/api/v1/conversations/${started.conversationId}?after_seq=${events[0]?.seq}&limit=3`,
        headers: { 'x-request-id': randomUUID() },
      } as unknown as IncomingMessage;
      interface JsonRes extends ServerResponse {
        status: number;
        payload: string;
      }
      const json = { status: 0, payload: '' };
      const res = {
        get status() {
          return json.status;
        },
        get payload() {
          return json.payload;
        },
        writeHead(status: number) {
          json.status = status;
        },
        end(body: string) {
          json.payload = body;
        },
      } as unknown as JsonRes;
      return { req, res, actorId };
    };

    const own = make(ownerId);
    await handleConversationRoute(
      own.req,
      own.res,
      new URL(own.req.url ?? '/', 'http://localhost'),
      {
        pool,
        timeContext,
        resolveActor: async () => ({
          ownerId: own.actorId,
          sessionId: null,
          displayName: 'tester',
          timezoneId: 'Asia/Shanghai',
        }),
      },
    );
    expect(own.res.status).toBe(200);
    const payload = JSON.parse(own.res.payload) as { data: { events: ThreadEvent[] } };
    expect(payload.data.events.map((event) => event.type)).toEqual([
      'message.delta',
      'card.proposed',
      'approval_required',
    ]);

    const other = make(randomUUID());
    await handleConversationRoute(
      other.req,
      other.res,
      new URL(other.req.url ?? '/', 'http://localhost'),
      {
        pool,
        timeContext,
        resolveActor: async () => ({
          ownerId: other.actorId,
          sessionId: null,
          displayName: 'other',
          timezoneId: 'Asia/Shanghai',
        }),
      },
    );
    expect(other.res.status).toBe(403);
  });

  it('SSE route emits data: frames that parse against the v1 envelope', async () => {
    const ownerId = await seedUser(pool);
    const frames: string[] = [];
    const req = {
      method: 'POST',
      url: '/api/v1/conversations/messages',
      headers: { 'x-request-id': randomUUID() },
    } as unknown as IncomingMessage;
    const res = new CapturedResponse(frames);

    const handled = await handleConversationRoute(
      req,
      res as unknown as ServerResponse,
      new URL(req.url ?? '/', 'http://localhost'),
      {
        pool,
        timeContext,
        resolveActor: async () => ({
          ownerId,
          sessionId: null,
          displayName: 'tester',
          timezoneId: 'Asia/Shanghai',
        }),
        body: { raw_text: '明天 9:20 提醒我喝水', confirmed_timezone: 'Asia/Shanghai' },
      },
    );
    expect(handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    const events = frames
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => ThreadEventSchema.parse(JSON.parse(frame.slice(6))));
    expect(events.map((e) => e.type)).toEqual([
      'thread.started',
      'message.delta',
      'card.proposed',
      'approval_required',
      'thread.completed',
    ]);
    expect(events[0]?.protocol_version).toBe('v1');
  });
});
