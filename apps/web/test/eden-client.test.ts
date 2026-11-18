import { describe, expect, it } from 'bun:test';
import { ApiReadError, readEnvelope } from '../src/shared/http/client';
import { createBrowserApi, writeOptions } from '../src/shared/http/eden';

const id = '11111111-1111-4111-8111-111111111111';

function success(data: unknown) {
  return Response.json({ code: 0, data, msg: 'ok', error: null, request_id: 'eden-request' });
}

describe('typed Eden JSON transport boundary', () => {
  it('uses only the same-origin proxy, preserves raw query values and forwards cancellation without credentials or capability headers', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = createBrowserApi(async (input, init) => {
      calls.push({ url: String(input), init });
      return success({ items: [], next_cursor: null });
    });
    const signal = new AbortController().signal;
    const cursor = 'opaque+cursor/with=&spaces ?';
    await api.api.v1.conversations({ id }).messages.get({
      query: { limit: '050', cursor },
      fetch: { signal },
    });
    const request = calls[0]!;
    const url = new URL(request.url, 'http://web.test');
    expect(request.url.startsWith('/api/v1/')).toBe(true);
    expect(url.pathname).toBe(`/api/v1/conversations/${id}/messages`);
    expect(url.searchParams.get('cursor')).toBe(cursor);
    expect(url.searchParams.get('limit')).toBe('050');
    expect(request.init?.cache).toBe('no-store');
    expect(request.init?.credentials).toBe('same-origin');
    expect(request.init?.signal).toBe(signal);
    const headers = new Headers(request.init?.headers);
    for (const name of ['authorization', 'cookie', 'x-along-local-model-proxy'])
      expect(headers.has(name)).toBe(false);
  });

  it('preserves success values and timestamp microseconds without converting them to Date', async () => {
    const created_at = '2026-11-18T12:00:00.123456Z';
    const data = {
      items: [{ message_id: id, role: 'user' as const, content: '原文', created_at }],
      next_cursor: null,
    };
    const api = createBrowserApi(async () => success(data));
    const result = await api.api.v1.conversations({ id }).messages.get();
    expect(result.error).toBeNull();
    expect(await readEnvelope(result)).toEqual(data);
    expect(result.data?.data.items[0]?.created_at).toBe(created_at);
  });

  it.each([401, 403, 409, 503])(
    'retains HTTP %i typed envelope errors and never replays a POST',
    async (status) => {
      let requests = 0;
      const api = createBrowserApi(async (_input, init) => {
        requests++;
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf');
        return Response.json(
          {
            code: status,
            data: null,
            msg: 'failed',
            error: { code: 'STATE_CONFLICT', message: '原始错误', request_id: 'eden-error' },
            request_id: 'eden-error',
          },
          { status },
        );
      });
      const result = await api.api.v1['model-providers']({ id }).actions.delete.post(
        {},
        writeOptions('csrf'),
      );
      expect(result.error?.status).toBe(status);
      expect(result.error?.value.error.code).toBe('STATE_CONFLICT');
      // Authentication navigation itself is covered by account-navigation.test.ts.
      await expect(readEnvelope(result)).rejects.toMatchObject({
        status,
        code: 'STATE_CONFLICT',
        requestId: 'eden-error',
      });
      expect(requests).toBe(1);
    },
  );

  it.each([200, 503])(
    'retains malformed JSON HTTP %i identity for ApiReadError',
    async (status) => {
      const api = createBrowserApi(
        async () =>
          new Response('{invalid', {
            status,
            headers: { 'content-type': 'application/json', 'x-request-id': 'invalid-json' },
          }),
      );
      const result = await api.api.v1.me.get();
      await expect(readEnvelope(result)).rejects.toBeInstanceOf(ApiReadError);
      await expect(readEnvelope(result)).rejects.toMatchObject({
        status,
        code: null,
        requestId: 'invalid-json',
      });
    },
  );

  it('preserves a real fetch AbortError instead of manufacturing a response-less 503', async () => {
    const controller = new AbortController();
    const aborted = new DOMException('cancelled', 'AbortError');
    let requests = 0;
    const api = createBrowserApi(async (_input, init) => {
      requests++;
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw aborted;
    });
    await expect(api.api.v1.me.get({ fetch: { signal: controller.signal } })).rejects.toBe(aborted);
    expect(requests).toBe(1);
  });

  it('preserves connection failures without synthesizing a successful/HTTP result or retrying', async () => {
    const disconnected = new TypeError('connection lost');
    let requests = 0;
    const api = createBrowserApi(async () => {
      requests++;
      throw disconnected;
    });
    await expect(api.api.v1.me.get()).rejects.toBe(disconnected);
    expect(requests).toBe(1);
  });
});

it.each([new DOMException('body cancelled', 'AbortError'), new TypeError('body connection lost')])(
  'does not turn interrupted JSON bodies into validation or HTTP failures',
  async (failure) => {
    const api = createBrowserApi(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(failure);
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(api.api.v1.me.get()).rejects.toBe(failure);
  },
);
