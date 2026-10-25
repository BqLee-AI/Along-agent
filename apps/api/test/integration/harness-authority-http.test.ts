import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { ThreadEventSchema } from '@along/stream-protocol';
import { RunViewSchema } from '@along/contracts';
import { z } from 'zod';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { handleRequest } from '../../src/http/app.js';
import { seedSession } from '../../src/modules/identity/seed.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;

maybe('harness authority signed HTTP boundary', () => {
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

  it('missing native services fails before SSE and writes no Run, message, invocation, or approval', async () => {
    const { session, headers } = await actor();
    const response = await post(
      '/api/v1/conversations/messages',
      {
        execution: 'harness',
        raw_text: '你好',
        idempotency_key: randomUUID(),
      },
      headers,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ error: { code: 'HARNESS_UNAVAILABLE' } });
    for (const table of ['agent_runs', 'messages', 'tool_invocations', 'approvals']) {
      expect(
        (
          await database.pool.query(`SELECT count(*)::int n FROM ${table} WHERE owner_id=$1`, [
            session.userId,
          ])
        ).rows[0]?.n,
      ).toBe(0);
    }
  });

  it('business/harness share inbound idempotency while omitted and explicit business replay exactly', async () => {
    const { headers } = await actor();
    const body = { raw_text: '你好', idempotency_key: randomUUID() };
    const original = await post('/api/v1/conversations/messages', body, headers);
    expect(original.status).toBe(200);
    const events = await original.text();
    const same = await post(
      '/api/v1/conversations/messages',
      { ...body, execution: 'business' },
      headers,
    );
    expect(same.status).toBe(200);
    expect(await same.text()).toBe(events);
    const changed = await post(
      '/api/v1/conversations/messages',
      { ...body, execution: 'harness' },
      headers,
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: 'STATE_CONFLICT' } });
    const injected = await post(
      '/api/v1/conversations/messages',
      {
        ...body,
        idempotency_key: randomUUID(),
        execution: 'harness',
        owner_id: randomUUID(),
        allowlist: ['effect'],
        binaryPath: 'injected',
      },
      headers,
    );
    expect(injected.status).toBe(400);
  });

  it('owner GET and CSRF cancel are durable and idempotent without executing a model or native process', async () => {
    const { session, headers } = await actor();
    const foreign = await actor();
    let models = 0;
    const started = await startConversationRun(
      {
        pool: database.pool,
        timeContext: loadTimeContext('fixture-v1'),
        harness: {
          binaryPath: process.env.HARNESS_BINARY ?? '/app/harness/bin/along-harness',
          maxIterations: 8,
          maxTokens: 8000,
          model: async () => {
            models += 1;
            throw new Error('GET/cancel must never call model');
          },
        },
      },
      session.userId,
      randomUUID(),
      { execution: 'harness', raw_text: '你好', idempotency_key: randomUUID() },
      null,
    );
    const path = `/api/v1/conversations/${started.conversationId}/runs/${started.runId}`;
    const get = await fetch(`${base}${path}`, { headers });
    expect(get.status).toBe(200);
    const view = z.object({ data: RunViewSchema }).parse(await get.json()).data;
    expect(view).toMatchObject({
      execution: 'harness',
      status: 'running',
      attempt_no: 1,
      waiting: null,
      can_resume: false,
    });
    expect((await fetch(`${base}${path}`, { headers: foreign.headers })).status).toBe(404);
    expect((await fetch(`${base}${path}`)).status).toBe(401);
    const body = { idempotency_key: randomUUID(), reason: 'user_cancelled' };
    expect((await post(`${path}/actions/cancel`, body, { cookie: headers.cookie })).status).toBe(
      403,
    );
    for (let n = 0; n < 2; n += 1) {
      const cancelled = await post(`${path}/actions/cancel`, body, headers);
      expect(cancelled.status).toBe(200);
      expect(z.object({ data: RunViewSchema }).parse(await cancelled.json()).data.status).toBe(
        'cancelled',
      );
    }
    const history = await fetch(`${base}/api/v1/conversations/${started.conversationId}`, {
      headers,
    });
    expect(history.status).toBe(200);
    const events = z
      .object({ data: z.object({ events: z.array(ThreadEventSchema) }) })
      .parse(await history.json()).data.events;
    expect(events.map((event) => event.type)).toEqual(['thread.cancelled']);
    expect(models).toBe(0);
    expect(
      (
        await database.pool.query('SELECT count(*)::int n FROM run_attempts WHERE run_id=$1', [
          started.runId,
        ])
      ).rows[0]?.n,
    ).toBe(1);
  });

  it('cancel reason bounds reject before writes and preserve the longest accepted reason once', async () => {
    const { session, headers } = await actor();
    const started = await startConversationRun(
      {
        pool: database.pool,
        timeContext: loadTimeContext('fixture-v1'),
        harness: {
          binaryPath: process.env.HARNESS_BINARY ?? '/app/harness/bin/along-harness',
          maxIterations: 8,
          maxTokens: 8000,
          model: async () => {
            throw new Error('cancel must never execute model');
          },
        },
      },
      session.userId,
      randomUUID(),
      { execution: 'harness', raw_text: 'cancel boundary', idempotency_key: randomUUID() },
      null,
    );
    const path = `/api/v1/conversations/${started.conversationId}/runs/${started.runId}`;
    const oversized = await post(
      `${path}/actions/cancel`,
      { idempotency_key: randomUUID(), reason: 'r'.repeat(201) },
      headers,
    );
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(
      (await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [started.runId]))
        .rows,
    ).toEqual([{ status: 'running' }]);
    for (const table of ['harness_cancellations', 'run_checkpoints', 'tool_invocations']) {
      expect(
        (
          await database.pool.query(`SELECT count(*)::int n FROM ${table} WHERE owner_id=$1`, [
            session.userId,
          ])
        ).rows[0]?.n,
      ).toBe(0);
    }
    const body = { idempotency_key: randomUUID(), reason: '理'.repeat(198) + '😀' };
    for (let n = 0; n < 2; n += 1) {
      const response = await post(`${path}/actions/cancel`, body, headers);
      expect(response.status).toBe(200);
      expect(z.object({ data: RunViewSchema }).parse(await response.json()).data.status).toBe(
        'cancelled',
      );
    }
    const history = await fetch(`${base}/api/v1/conversations/${started.conversationId}`, {
      headers,
    });
    const events = z
      .object({ data: z.object({ events: z.array(ThreadEventSchema) }) })
      .parse(await history.json()).data.events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'thread.cancelled',
      payload: { reason: body.reason },
    });
    expect(
      (
        await database.pool.query('SELECT reason FROM harness_cancellations WHERE run_id=$1', [
          started.runId,
        ])
      ).rows,
    ).toEqual([{ reason: body.reason }]);
  });

  it('explicit business execution preserves successful deterministic response and freezes business Run', async () => {
    const session = await seedSession(database.pool, {});
    const response = await fetch(`${base}/api/v1/conversations/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `better-auth.session_token=${session.token}`,
        'x-csrf-token': session.csrfToken,
      },
      body: JSON.stringify({
        execution: 'business',
        raw_text: '你好',
        idempotency_key: randomUUID(),
      }),
    });
    expect(response.status).toBe(200);
    const events = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => ThreadEventSchema.parse(JSON.parse(line.slice(6))));
    expect(events.map((event) => event.type)).toEqual([
      'thread.started',
      'message.delta',
      'thread.completed',
    ]);
    const started = events[0];
    if (!started || started.type !== 'thread.started') throw new Error('thread.started missing');
    const run = await database.pool.query(
      'SELECT execution,mode,status FROM agent_runs WHERE id=$1 AND owner_id=$2',
      [started.payload.run_id, session.userId],
    );
    expect(run.rows).toEqual([{ execution: 'business', mode: 'chat', status: 'done' }]);
  });
});
