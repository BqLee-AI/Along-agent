import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { z } from 'zod';
import {
  HarnessApprovalDecisionSchema,
  HarnessModelMessageSchema,
  RunViewSchema,
} from '@along/contracts';
import { ThreadEventSchema } from '@along/stream-protocol';
import type { ThreadEvent } from '@along/stream-protocol';
import { handleRequest } from '../../src/http/app.js';
import { createHarnessModelTransport } from '../../src/modules/conversations/harness-model.js';
import { seedSession } from '../../src/modules/identity/seed.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';
import {
  findModelObservation,
  frames,
  started,
  pending,
  jsonBody,
  listen,
} from '../helpers/harness-consumer.js';

const binaryPath = process.env.HARNESS_BINARY ?? '';
const maybe = binaryPath && databaseUrl ? describe : describe.skip;
const ModelBody = z.object({
  messages: z.array(HarnessModelMessageSchema),
});
const Detail = z.object({
  data: z.object({
    approval_id: z.string().uuid(),
    presentation_hash: z.string(),
    echo_text: z.string(),
  }),
});
const Run = z.object({ data: RunViewSchema });
const Observation = z.object({
  status: z.string(),
  result: z.object({ kind: z.string(), timezone_id: z.string().optional() }).passthrough(),
});
const Confirmed = z.object({ data: z.object({ task_id: z.string().uuid() }) });
const longAnswers = [
  { kind: 'longascii', content: 'a'.repeat(4001) },
  { kind: 'longunicode', content: 'a'.repeat(3999) + '😀' + '界'.repeat(4001) },
];

maybe('production native with actual signed HTTP, model HTTP and PostgreSQL', () => {
  let database: IntegrationDatabase;
  let server: Server;
  let modelServer: Server;
  let base: string;
  let maxIterations = 8;
  const modelCalls = new Map<string, number>();
  const hold = new Map<
    string,
    { started: PromiseWithResolvers<void>; closed: PromiseWithResolvers<boolean> }
  >();

  beforeAll(async () => {
    database = await createIntegrationDatabase();
    modelServer = createServer((req, res) => {
      void (async () => {
        const body = ModelBody.parse(await jsonBody(req));
        const original =
          body.messages.find((message) => message.content.includes('nativeCase:'))?.content ?? '';
        const marker = /nativeCase:([\w-]+):(\w+)/.exec(original);
        if (!marker) throw new Error('missing fixture marker');
        const id = marker[1]!;
        const kind = marker[2]!;
        modelCalls.set(id, (modelCalls.get(id) ?? 0) + 1);
        if (kind === 'hold') {
          const gate = hold.get(id);
          if (!gate) throw new Error('missing held provider');
          res.once('close', () => gate.closed.resolve(!res.writableEnded && res.destroyed));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"choices":[', () => gate.started.resolve());
          return;
        }
        const observed = findModelObservation(body.messages, Observation);
        const actualDecision = findModelObservation(body.messages, HarnessApprovalDecisionSchema);
        let content: string | null = null;
        let calls: {
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        }[] = [];
        const longAnswer = longAnswers.find((answer) => answer.kind === kind);
        if (longAnswer) {
          content = longAnswer.content;
        } else if (actualDecision) {
          if (actualDecision.kind !== 'task' || actualDecision.status !== 'consumed')
            throw new Error('expected consumed task decision');
          content = `记录结果 task:${actualDecision.task_id}`;
        } else if (observed && kind !== 'loop') {
          if (
            kind === 'plan' &&
            !body.messages.some(
              (message) =>
                message.role === 'assistant' && message.content === '先读取偏好，再核对结果。',
            )
          )
            throw new Error('visible plan was not retained in native model context');
          if (kind === 'plan') {
            const call = body.messages
              .flatMap((message) => ('tool_calls' in message ? message.tool_calls : []))
              .at(-1);
            const outcome = body.messages.findLast((message) => message.role === 'tool');
            if (
              !call ||
              !outcome ||
              outcome.tool_call_id !== call.id ||
              call.function.name !== 'get_user_prefs' ||
              call.function.arguments !== '{}'
            )
              throw new Error('provider requires a real function-call conversation');
          }
          content = `${observed.result.kind}:${observed.result.timezone_id}`;
        } else {
          const name = kind === 'create' ? 'propose_task' : 'get_user_prefs';
          if (kind === 'plan') content = '先读取偏好，再核对结果。';
          const args =
            kind === 'create'
              ? {
                  raw_time_text: '2027-11-02 09:20',
                  timezone_hint: 'Asia/Shanghai',
                  note: `native-${id}`,
                  occurrence: 'once',
                }
              : {};
          calls = [
            {
              id: 'provider-id-is-not-invocation',
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ];
        }
        res.end(
          JSON.stringify({
            choices: [{ message: { content, tool_calls: calls } }],
            usage: { total_tokens: 5 },
          }),
        );
      })().catch(() => {
        res.writeHead(500);
        res.end('fixture provider failed');
      });
    });
    const modelBase = await listen(modelServer);
    const model = createHarnessModelTransport({
      baseUrl: `${modelBase}/v1`,
      model: 'fixture-transport-only',
    });
    server = createServer((req, res) => {
      void handleRequest(req, res, {
        pool: database.pool,
        tzdbVersion: 'fixture-v1',
        harness: {
          binaryPath,
          libraryPath: process.env.HARNESS_LIBRARY_PATH ?? '/app/harness/lib',
          maxIterations,
          maxTokens: 8000,
          model,
        },
      }).catch(() => res.destroy());
    });
    base = await listen(server);
  });
  afterAll(async () => {
    for (const running of [server, modelServer]) {
      if (!running) continue;
      const closed = once(running, 'close');
      running.closeAllConnections();
      running.close();
      await closed;
    }
    await database?.close();
  });

  async function actor() {
    const session = await seedSession(database.pool, { timezoneId: 'Europe/London' });
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
  async function view(cid: string, rid: string, headers: Record<string, string>) {
    const response = await fetch(`${base}/api/v1/conversations/${cid}/runs/${rid}`, { headers });
    expect(response.status).toBe(200);
    return Run.parse(await response.json()).data;
  }
  function input(id: string, kind: string) {
    return {
      execution: 'harness',
      raw_text: `nativeCase:${id}:${kind} 2027-11-02 09:20`,
      confirmed_timezone: 'Asia/Shanghai',
      idempotency_key: randomUUID(),
    };
  }
  async function confirm(approvalId: string, headers: Record<string, string>) {
    const response = await fetch(`${base}/api/v1/approvals/${approvalId}`, { headers });
    const detail = Detail.parse(await response.json()).data;
    const confirmed = await post(
      `/api/v1/approvals/${approvalId}/actions/confirm`,
      {
        presentation_hash: detail.presentation_hash,
        seen_content: detail.echo_text,
        idempotency_key: randomUUID(),
      },
      headers,
    );
    expect(confirmed.status).toBe(200);
    return Confirmed.parse(await confirmed.json()).data.task_id;
  }

  for (const answer of longAnswers) {
    it(`native ${answer.kind} final answer survives public chunking and durable replay exactly`, async () => {
      const { headers } = await actor();
      const id = randomUUID();
      const body = input(id, answer.kind);
      const response = await post('/api/v1/conversations/messages', body, headers);
      expect(response.status).toBe(200);
      const text = await response.text();
      const events = frames(text);
      const run = started(events);
      const deltas = events.flatMap((event) =>
        event.type === 'message.delta' ? [event.payload.delta] : [],
      );
      expect(deltas.join('')).toBe(answer.content);
      expect(deltas.length).toBeGreaterThan(1);
      for (const delta of deltas) {
        expect(delta.length).toBeLessThanOrEqual(4000);
        expect(Buffer.from(delta, 'utf8').toString('utf8')).toBe(delta);
      }
      expect(events.filter((event) => event.type === 'thread.completed')).toHaveLength(1);
      expect(
        events.some((event) => event.type === 'thread.failed' || event.type === 'thread.cancelled'),
      ).toBe(false);
      expect((await view(run.conversation_id, run.run_id, headers)).status).toBe('done');
      expect(
        (
          await database.pool.query(
            `SELECT content FROM messages WHERE conversation_id=$1 AND role='assistant'`,
            [run.conversation_id],
          )
        ).rows,
      ).toEqual([{ content: answer.content }]);
      const replay = await post('/api/v1/conversations/messages', body, headers);
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(text);
      expect(modelCalls.get(id)).toBe(1);
    });
  }

  it('native observes the real owner preference and reread/repeated POST never execute again', async () => {
    const { session, headers } = await actor();
    const id = randomUUID();
    const body = input(id, 'read');
    const response = await post('/api/v1/conversations/messages', body, headers);
    expect(response.status).toBe(200);
    const text = await response.text();
    const events = frames(text);
    const run = started(events);
    expect(
      events
        .filter((event) => event.type === 'message.delta')
        .map((event) => event.payload.delta)
        .join(''),
    ).toBe('prefs:Europe/London');
    expect(events.at(-1)?.type).toBe('thread.completed');
    expect((await view(run.conversation_id, run.run_id, headers)).status).toBe('done');
    expect((await post('/api/v1/conversations/messages', body, headers)).status).toBe(200);
    const history = await fetch(`${base}/api/v1/conversations/${run.conversation_id}`, { headers });
    const stored = z
      .object({ data: z.object({ events: z.array(ThreadEventSchema) }) })
      .parse(await history.json()).data.events;
    expect(stored).toEqual(events);
    expect(modelCalls.get(id)).toBe(2);
    const effects = await database.pool.query(
      'SELECT tool_id,call_key,state FROM tool_invocations WHERE owner_id=$1',
      [session.userId],
    );
    expect(effects.rows).toEqual([
      { tool_id: 'get_user_prefs', call_key: 'harness/1', state: 'completed' },
    ]);
  });

  it('native publishes tool-call content as visible progress and retains it alongside the real next-round observation', async () => {
    const { headers } = await actor();
    const id = randomUUID();
    const response = await post('/api/v1/conversations/messages', input(id, 'plan'), headers);
    expect(response.status).toBe(200);
    const events = frames(await response.text());
    expect(
      events.filter((event) => event.type === 'message.delta').map((event) => event.payload.delta),
    ).toEqual(['先读取偏好，再核对结果。', 'prefs:Europe/London']);
    expect(events.at(-1)?.type).toBe('thread.completed');
    expect(modelCalls.get(id)).toBe(2);
  });

  it('approval waits without completed, then one concurrent resume consumes the original real task result', async () => {
    const { session, headers } = await actor();
    const id = randomUUID();
    const body = input(id, 'create');
    const initial = frames(
      await (await post('/api/v1/conversations/messages', body, headers)).text(),
    );
    const run = started(initial);
    const approvalId = pending(initial);
    expect(initial.some((event) => event.type === 'thread.completed')).toBe(false);
    const waiting = await view(run.conversation_id, run.run_id, headers);
    expect(waiting.status).toBe('suspended_approval');
    expect(waiting.can_resume).toBe(false);
    if (!waiting.waiting) throw new Error('missing persisted wait');
    const path = `/api/v1/conversations/${run.conversation_id}/runs/${run.run_id}/actions/resume`;
    const resume = { checkpoint_id: waiting.waiting.checkpoint_id, idempotency_key: randomUUID() };
    expect((await post(path, resume, headers)).status).toBe(409);
    expect(modelCalls.get(id)).toBe(1);
    const replay = frames(
      await (await post('/api/v1/conversations/messages', body, headers)).text(),
    );
    expect(replay).toEqual(initial);
    const taskId = await confirm(approvalId, headers);
    const replies = await Promise.all([post(path, resume, headers), post(path, resume, headers)]);
    for (const reply of replies) {
      expect([200, 409]).toContain(reply.status);
      if (reply.status === 200) {
        const resumed = frames(await reply.text());
        expect(resumed.some((event) => event.type === 'thread.started')).toBe(false);
        expect(
          resumed
            .filter((event) => event.type === 'message.delta')
            .map((event) => event.payload.delta)
            .join(''),
        ).toContain(taskId);
      } else await reply.arrayBuffer();
    }
    const final = await view(run.conversation_id, run.run_id, headers);
    expect(final).toMatchObject({ status: 'done', attempt_no: 2, waiting: null });
    expect((await post(path, { ...resume, idempotency_key: randomUUID() }, headers)).status).toBe(
      409,
    );
    expect((await post(path, resume, headers)).status).toBe(200);
    expect(modelCalls.get(id)).toBe(2);
    expect(
      (await database.pool.query('SELECT id FROM tasks WHERE owner_id=$1', [session.userId])).rows,
    ).toEqual([{ id: taskId }]);
    expect(
      (
        await database.pool.query('SELECT call_key FROM tool_invocations WHERE run_id=$1', [
          run.run_id,
        ])
      ).rows,
    ).toEqual([{ call_key: 'harness/1' }]);
  });

  it('a real rejection stops resumed native without asking the model or re-proposing', async () => {
    const { session, headers } = await actor();
    const id = randomUUID();
    const events = frames(
      await (await post('/api/v1/conversations/messages', input(id, 'create'), headers)).text(),
    );
    const run = started(events);
    const approvalId = pending(events);
    const waiting = await view(run.conversation_id, run.run_id, headers);
    if (!waiting.waiting) throw new Error('missing wait');
    expect(
      (
        await post(
          `/api/v1/approvals/${approvalId}/actions/reject`,
          { idempotency_key: randomUUID(), reason: 'do not create' },
          headers,
        )
      ).status,
    ).toBe(200);
    const resumed = await post(
      `/api/v1/conversations/${run.conversation_id}/runs/${run.run_id}/actions/resume`,
      { checkpoint_id: waiting.waiting.checkpoint_id, idempotency_key: randomUUID() },
      headers,
    );
    expect(resumed.status).toBe(200);
    const terminal = frames(await resumed.text());
    expect(terminal.at(-1)?.type).toBe('thread.failed');
    expect((await view(run.conversation_id, run.run_id, headers)).status).toBe('failed');
    expect(modelCalls.get(id)).toBe(1);
    expect(
      (
        await database.pool.query('SELECT count(*)::int n FROM tasks WHERE owner_id=$1', [
          session.userId,
        ])
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await database.pool.query('SELECT call_key FROM tool_invocations WHERE run_id=$1', [
          run.run_id,
        ])
      ).rows,
    ).toEqual([{ call_key: 'harness/1' }]);
  });

  it('durable stop interrupts the actual model HTTP body and native wait without any tool effect', async () => {
    const { session, headers } = await actor();
    const id = randomUUID();
    const gate = {
      started: Promise.withResolvers<void>(),
      closed: Promise.withResolvers<boolean>(),
    };
    hold.set(id, gate);
    const response = await post('/api/v1/conversations/messages', input(id, 'hold'), headers);
    const finished = response.text();
    await gate.started.promise;
    const row = (
      await database.pool.query<{ id: string; conversation_id: string }>(
        'SELECT id,conversation_id FROM agent_runs WHERE owner_id=$1',
        [session.userId],
      )
    ).rows[0];
    if (!row) throw new Error('missing running native');
    const path = `/api/v1/conversations/${row.conversation_id}/runs/${row.id}`;
    const reason = '理'.repeat(198) + '😀';
    const cancelled = await post(
      `${path}/actions/cancel`,
      { idempotency_key: randomUUID(), reason },
      headers,
    );
    expect(cancelled.status).toBe(200);
    expect(Run.parse(await cancelled.json()).data.status).toBe('cancelled');
    expect(await gate.closed.promise).toBe(true);
    const events = frames(await finished);
    expect(events.filter((event) => event.type === 'thread.cancelled')).toHaveLength(1);
    expect(events.find((event) => event.type === 'thread.cancelled')).toMatchObject({
      payload: { reason },
    });
    expect(
      events.some((event) => event.type === 'thread.failed' || event.type === 'thread.completed'),
    ).toBe(false);
    expect((await view(row.conversation_id, row.id, headers)).status).toBe('cancelled');
    expect(
      (
        await database.pool.query('SELECT count(*)::int n FROM tool_invocations WHERE run_id=$1', [
          row.id,
        ])
      ).rows[0]?.n,
    ).toBe(0);
    expect(modelCalls.get(id)).toBe(1);
    hold.delete(id);
  });

  it('the native iteration ceiling stops repeated real read effects instead of a TS character estimate', async () => {
    const { headers } = await actor();
    const id = randomUUID();
    maxIterations = 3;
    let events: ThreadEvent[];
    try {
      events = frames(
        await (await post('/api/v1/conversations/messages', input(id, 'loop'), headers)).text(),
      );
    } finally {
      maxIterations = 8;
    }
    const run = started(events);
    const last = events.at(-1);
    expect(last?.type).toBe('thread.failed');
    if (!last || last.type !== 'thread.failed') throw new Error('missing budget terminal');
    expect(last.payload.error.code).toBe('BUDGET_EXCEEDED');
    expect(modelCalls.get(id)).toBe(3);
    expect(
      (
        await database.pool.query(
          'SELECT call_key,state FROM tool_invocations WHERE run_id=$1 ORDER BY call_key',
          [run.run_id],
        )
      ).rows,
    ).toEqual([
      { call_key: 'harness/1', state: 'completed' },
      { call_key: 'harness/2', state: 'completed' },
      { call_key: 'harness/3', state: 'completed' },
    ]);
  });

  it('accepted approval facts survive a genuine snapshot INSERT failure and subsequent rereads do not repeat them', async () => {
    const { session, headers } = await actor();
    const id = randomUUID();
    const suffix = randomUUID().replaceAll('-', '');
    const fn = `fail_native_snapshot_${suffix}`;
    const trigger = `fail_native_snapshot_${suffix}`;
    await database.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.owner_id='${session.userId}'::uuid AND NEW.kind='harness_snapshot' THEN RAISE EXCEPTION 'snapshot storage unavailable'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER ${trigger} BEFORE INSERT ON run_checkpoints FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    const body = input(id, 'create');
    let events: ThreadEvent[];
    try {
      events = frames(await (await post('/api/v1/conversations/messages', body, headers)).text());
    } finally {
      await database.pool.query(
        `DROP TRIGGER ${trigger} ON run_checkpoints; DROP FUNCTION ${fn}()`,
      );
    }
    const run = started(events);
    expect(events.at(-1)?.type).toBe('thread.failed');
    expect((await view(run.conversation_id, run.run_id, headers)).status).toBe('failed');
    const accepted = await database.pool.query(
      'SELECT state,approval_id FROM tool_invocations WHERE run_id=$1',
      [run.run_id],
    );
    expect(accepted.rows).toEqual([{ state: 'completed', approval_id: pending(events) }]);
    const repeated = frames(
      await (await post('/api/v1/conversations/messages', body, headers)).text(),
    );
    expect(repeated).toEqual(events);
    expect(modelCalls.get(id)).toBe(1);
    expect(
      (await database.pool.query('SELECT id FROM approvals WHERE owner_id=$1', [session.userId]))
        .rows,
    ).toEqual([{ id: pending(events) }]);
  });
});
