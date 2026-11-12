import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ThreadEventSchema } from '@along/stream-protocol';
import type { ThreadEvent } from '@along/stream-protocol';
import type { GoalResult } from '@along/contracts';
import { NextRequest } from 'next/server';
import {
  collectRunTranscripts,
  consumeThreadStream,
  followRunEvents,
  mergeThreadEvents,
} from '../src/features/conversations/model/conversation-run';
import { readEnvelope } from '../src/shared/http/client';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import type { GET as ProxyGet } from '../src/app/api/[...path]/route';
import { MeSchema } from '../src/shared/session/identity';

const cid = '11111111-1111-4111-8111-111111111111';
const rid = '22222222-2222-4222-8222-222222222222';
function event(
  seq: number,
  type: ThreadEvent['type'],
  payload: Record<string, unknown> = {},
): ThreadEvent {
  const fields =
    type === 'thread.started'
      ? { stream_protocol_version: 'v1', ruleset_id: 'rules-v1', tzdb_version: '2026a', ...payload }
      : type === 'approval_required'
        ? { card_id: 'card-1', presentation_hash: 'frozen-presentation', ...payload }
        : type === 'thread.completed'
          ? { approval_id: null, ...payload }
          : payload;
  return ThreadEventSchema.parse({
    protocol_version: 'v1',
    seq,
    type,
    payload: { conversation_id: cid, run_id: rid, ...fields },
    request_id: 'request-1',
  });
}
function request(path: string, init?: { signal?: AbortSignal }): NextRequest {
  return new NextRequest(`http://web.test/api/${path}`, init);
}

// These exercise the browser's actual event/read consumers and proxy stream,
// not source text. Browser action/DOM evidence is collected by integration.
describe('Run event consumers', () => {
  it('reconnects only with GET and the accepted persisted cursor, without duplicating deltas', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const accepted: ThreadEvent[] = [];
    const started = event(1, 'thread.started');
    const delta = event(4, 'message.delta', { delta: '继续' });
    const done = event(7, 'thread.completed');
    const responses = [
      [started, delta],
      [delta, done],
    ];
    await followRunEvents({
      conversationId: cid,
      runId: rid,
      signal: new AbortController().signal,
      cursor: () => accepted.at(-1)?.seq ?? 0,
      onEvent: (value) => accepted.push(value),
      readStatus: async () => (calls.length === 1 ? 'running' : 'done'),
      retryDelay: 0,
      fetchEvents: async (url, init) => {
        calls.push({ url: String(url), method: init?.method });
        return new Response(
          responses[calls.length - 1]!.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(
            '',
          ),
        );
      },
    });
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET']);
    expect(
      calls.map((call) => new URL(call.url, 'http://web.test').searchParams.get('after_seq')),
    ).toEqual(['0', '4']);
    expect(accepted.map((value) => value.seq)).toEqual([1, 4, 7]);
  });

  it('bounds disconnection retries and rejects events from a different Run', async () => {
    let calls = 0;
    const accepted: ThreadEvent[] = [];
    await expect(
      followRunEvents({
        conversationId: cid,
        runId: rid,
        signal: new AbortController().signal,
        cursor: () => 0,
        onEvent: (value) => accepted.push(value),
        readStatus: async () => 'running',
        retryDelay: 0,
        fetchEvents: async () => {
          calls++;
          return new Response(
            `data: ${JSON.stringify(event(1, 'thread.started', { run_id: cid }))}\n\n`,
          );
        },
      }),
    ).rejects.toThrow('订阅事件与指定会话 / Run 不匹配');
    expect(calls).toBe(3);
    expect(accepted).toEqual([]);
  });
  it('stops following when access is revoked without another GET', async () => {
    let calls = 0;
    await expect(
      followRunEvents({
        conversationId: cid,
        runId: rid,
        signal: new AbortController().signal,
        cursor: () => 0,
        onEvent: () => {
          throw new Error('unexpected event');
        },
        readStatus: async () => 'running',
        retryDelay: 0,
        fetchEvents: async () => {
          calls++;
          return new Response(
            JSON.stringify({
              code: 1,
              data: null,
              msg: 'forbidden',
              error: { code: 'FORBIDDEN', message: 'forbidden' },
              request_id: 'revoked',
            }),
            { status: 403 },
          );
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('does not turn normal approval suspension EOF into a terminal event', async () => {
    const incoming = [
      event(1, 'thread.started'),
      event(3, 'message.delta', { delta: '等待确认' }),
      event(4, 'approval_required', { approval_id: cid }),
    ];
    const encoded = incoming.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join('');
    const bytes = new TextEncoder().encode(encoded);
    const observed: ThreadEvent[] = [];
    await consumeThreadStream(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 27));
            controller.enqueue(bytes.slice(27, 123));
            controller.enqueue(bytes.slice(123));
            controller.close();
          },
        }),
      ),
      (value) => observed.push(value),
    );
    expect(observed).toEqual(incoming);
    expect(observed.at(-1)?.type).toBe('approval_required');
  });

  it('normalizes out-of-order rereads and continuation, keeping the first accepted event per seq across gaps', () => {
    const started = event(10, 'thread.started');
    const delta = event(12, 'message.delta', { delta: '已提议。' });
    let observed = mergeThreadEvents([], [started, delta]);
    observed = mergeThreadEvents(observed, [
      started,
      delta,
      event(20, 'thread.completed'),
      event(12, 'message.delta', { delta: '不得覆盖已接受增量。' }),
      event(19, 'message.delta', { delta: '已确认。' }),
      event(19, 'message.delta', { delta: '不得重复追加。' }),
    ]);
    expect(observed.map((value) => value.seq)).toEqual([10, 12, 19, 20]);
    expect(observed.filter((value) => value.type === 'thread.started')).toHaveLength(1);
    expect(
      observed
        .filter((value) => value.type === 'message.delta')
        .map((value) => value.payload.delta)
        .join(''),
    ).toBe('已提议。已确认。');
  });

  it('consumes v2 lifecycle and durable outcomes without promoting deltas or erasing accepted effects on cancellation', async () => {
    const goalResult: GoalResult = {
      status: 'cancelled',
      outcomes: [
        { description: '默认时区已保存为 Asia/Shanghai', status: 'achieved', receipt_refs: [cid] },
        { description: '后续问题尚未回答', status: 'not_done', receipt_refs: [] },
      ],
      clarification: null,
      answer: '设置已保存；执行随后停止，尚未回答后续问题。',
    };
    const incoming = [
      ThreadEventSchema.parse({
        protocol_version: 'v2',
        seq: 1,
        type: 'thread.started',
        payload: {
          conversation_id: cid,
          run_id: rid,
          stream_protocol_version: 'v2',
          ruleset_id: 'rules-v1',
          tzdb_version: '2026a',
          authorization_revision: 'delegation/1',
          execution_lifecycle: 'request-bound',
        },
        request_id: 'delegation-consumer',
      }),
      ThreadEventSchema.parse({
        protocol_version: 'v2',
        seq: 2,
        type: 'message.delta',
        payload: { conversation_id: cid, run_id: rid, delta: '尚在生成的正文' },
        request_id: 'delegation-consumer',
      }),
      ThreadEventSchema.parse({
        protocol_version: 'v2',
        seq: 4,
        type: 'thread.cancelled',
        payload: {
          conversation_id: cid,
          run_id: rid,
          reason: 'client_disconnected',
          goal_result: goalResult,
        },
        request_id: 'delegation-consumer',
      }),
    ];
    const accepted: ThreadEvent[] = [];
    await consumeThreadStream(
      new Response(incoming.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')),
      (value) => accepted.push(value),
    );
    const started = collectRunTranscripts(accepted.slice(0, 1)).get(rid)!;
    expect(started.authorization_revision).toBe('delegation/1');
    expect(started.execution_lifecycle).toBe('request-bound');
    expect(started.goal_result).toBeUndefined();
    expect(collectRunTranscripts(accepted.slice(0, 2)).get(rid)?.goal_result).toBeUndefined();
    const restored = collectRunTranscripts(mergeThreadEvents(accepted, accepted)).get(rid)!;
    expect(restored.text).toBe('尚在生成的正文');
    expect(restored.goal_result).toEqual(goalResult);
    expect(restored.goal_result?.outcomes[0]?.receipt_refs).toEqual([cid]);
    expect(collectRunTranscripts(accepted, { includeText: false }).get(rid)?.goal_result).toEqual(
      goalResult,
    );
    expect(
      collectRunTranscripts([event(1, 'thread.started'), event(3, 'thread.completed')]).get(rid)
        ?.goal_result,
    ).toBeUndefined();
  });
});

describe('actual HTTP session response consumers', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const devActor = req.url === '/dev';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            user: { id: cid, display_name: 'Session consumer' },
            csrf_token: devActor ? null : 'production-session-csrf',
            confirmed_timezone: 'Asia/Shanghai',
          },
          msg: 'ok',
          error: null,
          request_id: 'session-consumer',
        }),
      );
    });
    const ready = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await ready;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing session server port');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    const stopped = once(server, 'close');
    server.closeAllConnections();
    server.close();
    await stopped;
  });

  it.each([
    ['dev', null],
    ['session', 'production-session-csrf'],
  ] as const)(
    'accepts the documented %s actor without replacing its CSRF token',
    async (kind, token) => {
      const me = MeSchema.parse(await readEnvelope(await fetch(`${base}/${kind}`)));
      expect(me.csrf_token).toBe(token);
      expect(me.confirmed_timezone).toBe('Asia/Shanghai');
    },
  );
});

describe('same-origin Run proxy', () => {
  let server: Server;
  let proxyGet: typeof ProxyGet;
  const closed = new Map<string, { promise: Promise<boolean>; resolve(value: boolean): void }>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      const kind = new URL(req.url!, 'http://upstream.test').searchParams.get('kind')!;
      if (kind === 'auth') {
        res.writeHead(503, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'set-cookie': ['first=session; Path=/; HttpOnly', 'second=state; Path=/; HttpOnly'],
          'x-private-upstream': 'must-not-forward',
        });
        res.end(
          JSON.stringify({
            origin: req.headers.origin ?? null,
            forwardedOrigin: req.headers['x-forwarded-origin'] ?? null,
          }),
        );
        return;
      }
      res.once('close', () => closed.get(kind)?.resolve(!res.writableEnded && res.destroyed));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: waiting\n\n');
    });
    const ready = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await ready;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing upstream port');
    const originalBase = process.env.API_BASE;
    try {
      process.env.API_BASE = `http://127.0.0.1:${address.port}`;
      // API_BASE is captured at module load. This test crosses that loading
      // boundary only after the real upstream has acquired an ephemeral port.
      ({ GET: proxyGet } = await import('../src/app/api/[...path]/route'));
    } finally {
      if (originalBase === undefined) delete process.env.API_BASE;
      else process.env.API_BASE = originalBase;
    }
  });
  afterAll(async () => {
    const stopped = once(server, 'close');
    server.closeAllConnections();
    server.close();
    await stopped;
  });

  it.each(['http://web.test', undefined])(
    'forwards only actual Origin %j, multiple cookies and no-store on auth errors',
    async (origin) => {
      const headers = new Headers({
        'content-type': 'application/json',
        'x-forwarded-origin': 'http://forged.test',
      });
      if (origin) headers.set('origin', origin);
      const response = await proxyGet(
        new NextRequest('http://web.test/api/v1/auth/sign-in?kind=auth', {
          method: 'POST',
          headers,
          body: '{}',
        }),
        { params: Promise.resolve({ path: ['v1', 'auth', 'sign-in'] }) },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ origin: origin ?? null, forwardedOrigin: null });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.getSetCookie()).toEqual([
        'first=session; Path=/; HttpOnly',
        'second=state; Path=/; HttpOnly',
      ]);
      expect(response.headers.get('x-private-upstream')).toBeNull();
    },
  );

  it.each(['request', 'reader'] as const)(
    'closes the actual unfinished upstream HTTP response on %s cancellation',
    async (kind) => {
      const receipt = Promise.withResolvers<boolean>();
      closed.set(kind, receipt);
      const controller = new AbortController();
      const response = await proxyGet(
        request(`v1/conversations?kind=${kind}`, { signal: controller.signal }),
        { params: Promise.resolve({ path: ['v1', 'conversations'] }) },
      );
      const reader = response.body!.getReader();
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: waiting\n\n');
        if (kind === 'request') controller.abort('client disconnected');
        else await reader.cancel('page closed');
        expect(await receipt.promise).toBe(true);
      } finally {
        await reader.cancel().catch(() => undefined);
        closed.delete(kind);
      }
    },
  );
});
