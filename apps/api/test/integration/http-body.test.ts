import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Agent, createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { handleRequest } from '../../src/http/app.js';
import { seedSession } from '../../src/modules/identity/seed.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedApproval,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;

maybe('HTTP bounded bodies with real sessions and transactions', () => {
  let database: IntegrationDatabase;
  let server: Server;
  let base: string;
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });

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
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    agent.destroy();
    if (server) {
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
    }
    await database?.close();
  });

  function post(path: string, body: unknown, headers: Record<string, string>) {
    const result = Promise.withResolvers<{
      status: number;
      text: string;
      reused: boolean;
      connection: string | undefined;
      requestId: string | string[] | undefined;
    }>();
    const req = request(`${base}${path}`, {
      method: 'POST',
      agent,
      headers: { 'content-type': 'application/json', ...headers },
    });
    req.on('error', result.reject);
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('error', result.reject);
      res.on('end', () =>
        result.resolve({
          status: res.statusCode!,
          text,
          reused: req.reusedSocket,
          connection: res.headers.connection,
          requestId: res.headers['x-request-id'],
        }),
      );
    });
    req.end(JSON.stringify(body));
    return result.promise;
  }

  it('preserves real session CSRF, SSE, frozen confirmation, idempotency and task cancellation over reusable HTTP', async () => {
    const session = await seedSession(database.pool, {});
    const cookie = { cookie: `better-auth.session_token=${session.token}` };
    const headers = { ...cookie, 'x-csrf-token': session.csrfToken };
    const denied = await post('/api/v1/conversations/messages', { raw_text: '你好' }, cookie);
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.text)).toMatchObject({
      code: 403,
      error: { code: 'FORBIDDEN', details: { reason: 'CSRF_MISMATCH' } },
    });

    const message = await post(
      '/api/v1/conversations/messages',
      { raw_text: '你好', idempotency_key: randomUUID() },
      { ...headers, 'x-request-id': 'body-business-43' },
    );
    expect(message.status).toBe(200);
    const frames = message.text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    expect(frames[0].type).toBe('thread.started');
    expect(frames.at(-1).type).toBe('thread.completed');
    expect(frames.every((frame) => frame.request_id === 'body-business-43')).toBe(true);
    expect(message.connection).toBe('keep-alive');

    const approval = await seedApproval(database.pool, { ownerId: session.userId });
    const detailResponse = await fetch(`${base}/api/v1/approvals/${approval.id}`, { headers });
    expect(detailResponse.status).toBe(200);
    const { data: detail } = (await detailResponse.json()) as {
      data: { presentation_hash: string; echo_text: string };
    };
    const body = {
      presentation_hash: detail.presentation_hash,
      seen_content: detail.echo_text,
      idempotency_key: randomUUID(),
    };
    const confirm = await post(`/api/v1/approvals/${approval.id}/actions/confirm`, body, headers);
    expect(confirm.status).toBe(200);
    expect(confirm.reused).toBe(true);
    expect(confirm.connection).toBe('keep-alive');
    const confirmed = JSON.parse(confirm.text);
    expect(confirmed.request_id).toBe(confirm.requestId);
    const replay = await post(`/api/v1/approvals/${approval.id}/actions/confirm`, body, headers);
    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.text).data.task_id).toBe(confirmed.data.task_id);
    const cancelled = await post(
      `/api/v1/tasks/${confirmed.data.task_id}/actions/cancel`,
      { idempotency_key: randomUUID() },
      headers,
    );
    expect(cancelled.status).toBe(200);
    // No worker/queue-revocation receipt has run: submission must not invent one.
    expect(JSON.parse(cancelled.text).data.state).toBe('cancel_pending');
    const { rows } = await database.pool.query('SELECT type FROM task_events WHERE task_id=$1', [
      confirmed.data.task_id,
    ]);
    expect(rows.filter((row) => row.type === 'created')).toHaveLength(1);
    expect(rows.filter((row) => row.type === 'cancel_requested')).toHaveLength(1);
    expect(rows.filter((row) => row.type === 'cancelled')).toHaveLength(0);
  });
});
