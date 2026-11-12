import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { ConversationMessagePageSchema } from '@along/contracts';
import {
  collectRunTranscripts,
  mergeThreadEvents,
  readHistoryEventPage,
} from '../src/features/conversations/model/conversation-run';
import { readHistoryCollectionPage } from '../src/shared/http/page';

const cid = '11111111-1111-4111-8111-111111111111';
const rid = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';
const raw = '  原话第一行\n第二行  \n';
const timestamp = '2026-10-28T12:00:00.123456Z';

describe('actual HTTP readonly history consumers', () => {
  let server: Server;
  let base: string;
  const requests: { method: string | undefined; url: string }[] = [];
  const deltas = Array.from({ length: 200 }, (_, index) => ({
    protocol_version: 'v1',
    seq: (index + 1) * 2,
    type: 'message.delta',
    request_id: 'history-http',
    payload: { conversation_id: cid, run_id: rid, delta: index === 0 ? '第一轮。' : '续' },
  }));

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://history.test');
      requests.push({ method: request.method, url: `${url.pathname}${url.search}` });
      let status = 200;
      let data: unknown;
      if (url.pathname === '/events' || url.pathname === '/mismatch-events') {
        data = {
          conversation_id: cid,
          status: 'open',
          confirmed_timezone_id: null,
          anchor_received_at_utc: null,
          events:
            url.pathname === '/mismatch-events'
              ? [{ ...deltas[0], payload: { ...deltas[0]!.payload, run_id: messageId } }]
              : url.searchParams.get('after_seq') === '400'
                ? []
                : deltas,
          next_after_seq: url.searchParams.get('after_seq') === '400' ? null : 400,
        };
      } else if (url.pathname === '/unavailable') {
        status = 503;
      } else {
        const tail = url.searchParams.get('cursor') === 'tail';
        data = {
          items: [
            {
              message_id: tail ? messageId : cid,
              role: url.pathname === '/invalid-messages' ? 'system' : tail ? 'assistant' : 'user',
              content: tail ? '最终档案，不应重复' : raw,
              created_at: timestamp,
            },
          ],
          next_cursor: tail ? null : 'tail',
        };
      }
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(
        JSON.stringify(
          status === 200
            ? { code: 0, data, msg: 'ok', error: null, request_id: 'history-http' }
            : {
                code: 50301,
                data: null,
                msg: 'failed',
                error: {
                  code: 'NOT_READY',
                  message: 'Read unavailable',
                  request_id: 'history-http-failure',
                },
                request_id: 'history-http-failure',
              },
        ),
      );
    });
    const ready = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await ready;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing history HTTP port');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    const stopped = once(server, 'close');
    server.closeAllConnections();
    server.close();
    await stopped;
  });

  it('reads every message page through strict shared DTOs without trimming original whitespace or timestamp microseconds', async () => {
    const first = await readHistoryCollectionPage(
      `${base}/messages`,
      ConversationMessagePageSchema,
    );
    const second = await readHistoryCollectionPage(
      `${base}/messages?cursor=${first.next_cursor}`,
      ConversationMessagePageSchema,
    );
    expect(first.items[0]?.content).toBe(raw);
    expect(first.items[0]?.created_at).toBe(timestamp);
    expect(second.items[0]?.role).toBe('assistant');
    expect(second.next_cursor).toBeNull();
    expect(requests.filter((request) => request.url.startsWith('/messages'))).toEqual([
      { method: 'GET', url: '/messages' },
      { method: 'GET', url: '/messages?cursor=tail' },
    ]);
  });

  it('reads the empty final event page after an exactly-full page instead of treating next_after_seq as has_more', async () => {
    const first = await readHistoryEventPage(`${base}/events?after_seq=0`, cid, rid, 0);
    expect(first.nextCursor).toBe('400');
    const last = await readHistoryEventPage(
      `${base}/events?after_seq=${first.nextCursor}`,
      cid,
      rid,
      Number(first.nextCursor),
    );
    expect(last.items).toEqual([]);
    expect(last.nextCursor).toBeNull();
    const events = mergeThreadEvents([], [...first.items, ...last.items, first.items[0]!]);
    const transcript = collectRunTranscripts(events).get(rid)!;
    expect(transcript.text).toBe(`第一轮。${'续'.repeat(199)}`);
    expect(transcript.text).not.toContain('最终档案');
    const previous = collectRunTranscripts(events);
    const delta = events.find((event) => event.type === 'message.delta')!;
    const next = collectRunTranscripts(
      mergeThreadEvents(events, [
        {
          ...delta,
          seq: 401,
          payload: { ...delta.payload, run_id: messageId, delta: '另一次运行。' },
        },
      ]),
      { previous },
    );
    expect(next.get(rid)).toBe(previous.get(rid));
    expect(next.get(messageId)?.text).toBe('另一次运行。');
    expect(requests.filter((request) => request.url.startsWith('/events'))).toEqual([
      { method: 'GET', url: '/events?after_seq=0' },
      { method: 'GET', url: '/events?after_seq=400' },
    ]);
  });

  it('rejects internal message roles and mismatched Run events rather than rendering or silently dropping them', async () => {
    await expect(
      readHistoryCollectionPage(`${base}/invalid-messages`, ConversationMessagePageSchema),
    ).rejects.toThrow();
    await expect(readHistoryEventPage(`${base}/mismatch-events`, cid, rid, 0)).rejects.toThrow(
      '不匹配',
    );
  });

  it('retains actual dependency failure identity and performs no action POST on a read retry', async () => {
    for (let retry = 0; retry < 2; retry++) {
      await expect(
        readHistoryCollectionPage(`${base}/unavailable`, ConversationMessagePageSchema),
      ).rejects.toMatchObject({
        status: 503,
        code: 'NOT_READY',
        requestId: 'history-http-failure',
      });
    }
    expect(requests.filter((request) => request.url === '/unavailable')).toEqual([
      { method: 'GET', url: '/unavailable' },
      { method: 'GET', url: '/unavailable' },
    ]);
    expect(requests.some((request) => request.method !== 'GET')).toBe(false);
  });
});
