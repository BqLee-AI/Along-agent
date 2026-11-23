import { expect, test } from 'bun:test';
import type { NextRequest } from 'next/server';
import { GET, POST } from '../src/app/api/[...path]/route';
import {
  changeMicrosoftLearnConnection,
  readMicrosoftLearnStatus,
} from '../src/features/capabilities/model/microsoft-learn-connection';

const segments = ['v1', 'connections', 'microsoft-learn'];
const base = `/api/${segments.join('/')}`;
const origin = 'http://web.test';
const csrf = 'synthetic-csrf';

function success(data: unknown) {
  return Response.json({ code: 0, data, msg: 'ok', error: null, request_id: 'test' });
}

function me(csrfToken: string | null) {
  return success({
    user: { id: '00000000-0000-4000-8000-000000000001', display_name: 'Tester' },
    csrf_token: csrfToken,
    confirmed_timezone: null,
  });
}

test('proxy forwards browser Origin and CSRF only on the exact Microsoft Learn connection routes', async () => {
  const original = globalThis.fetch;
  const observed: Array<{
    url: URL;
    method: string | undefined;
    origin: string | null;
    csrf: string | null;
    cookie: string | null;
    redirect: RequestRedirect | undefined;
    body: string;
  }> = [];
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    observed.push({
      url: new URL(String(input)),
      method: init?.method,
      origin: headers.get('origin'),
      csrf: headers.get('x-csrf-token'),
      cookie: headers.get('cookie'),
      redirect: init?.redirect,
      body: await new Response(init?.body).text(),
    });
    return new Response('response', { headers: { 'cache-control': 'public, max-age=60' } });
  }) as typeof fetch;
  try {
    const cases = [
      { path: segments, method: 'GET', exact: true },
      { path: [...segments, 'connect'], method: 'POST', exact: true },
      { path: [...segments, 'disconnect'], method: 'POST', exact: true },
      { path: segments, method: 'POST', exact: false },
      { path: [...segments, 'connect'], method: 'GET', exact: false },
      { path: [...segments, 'connect', 'extra'], method: 'POST', exact: false },
      { path: [...segments, 'connect', ''], method: 'POST', exact: false },
      {
        path: [...segments, 'connect'],
        sourcePath: `${base}/%63onnect`,
        method: 'POST',
        exact: false,
      },
      { path: ['v1', 'connections', 'other', 'connect'], method: 'POST', exact: false },
      {
        path: ['v1', 'alias', '..', ...segments.slice(1), 'connect'],
        method: 'POST',
        exact: false,
      },
      { path: [...segments, 'search'], method: 'POST', exact: false },
    ];
    for (const { path, method, exact, sourcePath } of cases) {
      const body = method === 'POST' ? '{}' : undefined;
      const pathname = `/api/${path.join('/')}`;
      const url = new URL(sourcePath ?? pathname, origin);
      url.searchParams.set('url', 'https://untrusted.test/api/mcp');
      const request = new Request(url, {
        method,
        headers: { origin, 'x-csrf-token': csrf, cookie: 'session=synthetic' },
        body,
      }) as NextRequest;
      const handler = method === 'GET' ? GET : POST;
      const response = await handler(request, { params: Promise.resolve({ path }) });
      expect(response.headers.get('cache-control')).toBe(exact ? 'no-store' : 'public, max-age=60');
      expect(await response.text()).toBe('response');
      const observation = observed.at(-1)!;
      expect(observation.url.pathname).toBe(new URL(pathname, origin).pathname);
      expect(observation.url.origin).toBe(
        new URL(process.env.API_BASE ?? 'http://127.0.0.1:3000').origin,
      );
      expect(observation).toMatchObject({
        method,
        origin: exact ? origin : null,
        csrf: exact ? csrf : null,
        cookie: 'session=synthetic',
        redirect: 'manual',
        body: body ?? '',
      });
    }
    const path = [...segments, 'connect'];
    const response = await POST(
      new Request(`${origin}${base}/connect`, { method: 'POST' }) as NextRequest,
      { params: Promise.resolve({ path }) },
    );
    await response.text();
    expect(observed.at(-1)).toMatchObject({ origin: null, csrf: null });
    expect(observed).toHaveLength(cases.length + 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('read and writes use only the fixed local status, Me and CSRF-protected action requests', async () => {
  const original = globalThis.fetch;
  const signal = new AbortController().signal;
  const requests: unknown[] = [];
  globalThis.fetch = (async (url, init) => {
    const headers = new Headers(init?.headers);
    requests.push([
      String(url),
      init?.method ?? 'GET',
      init?.body,
      headers.get('content-type'),
      headers.get('x-csrf-token'),
      headers.get('origin'),
    ]);
    expect(init?.signal).toBe(signal);
    if (url === '/api/v1/me') return me(csrf);
    if (url === base) expect(init?.cache).toBe('no-store');
    return success({ state: url === `${base}/connect` ? 'connected' : 'idle' });
  }) as typeof fetch;
  try {
    expect(await readMicrosoftLearnStatus(signal)).toEqual({ state: 'idle' });
    expect(await changeMicrosoftLearnConnection('connect', signal)).toEqual({ state: 'connected' });
    expect(await changeMicrosoftLearnConnection('disconnect', signal)).toEqual({ state: 'idle' });
    expect(requests).toEqual([
      [base, 'GET', undefined, null, null, null],
      ['/api/v1/me', 'GET', undefined, null, null, null],
      [`${base}/connect`, 'POST', '{}', 'application/json', csrf, null],
      ['/api/v1/me', 'GET', undefined, null, null, null],
      [`${base}/disconnect`, 'POST', '{}', 'application/json', csrf, null],
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test('failed, invalid and canceled connection responses do not trigger automatic writes or retries', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const requests: string[] = [];
  let csrfToken: string | null = null;
  let cancelAfterMe = false;
  globalThis.fetch = (async (url) => {
    requests.push(String(url));
    if (url === '/api/v1/me') {
      if (cancelAfterMe) controller.abort();
      return me(csrfToken);
    }
    if (url === base) return success({ state: 'connected', serviceHealth: 'ok' });
    return Response.json(
      { code: 403, data: null, msg: 'forbidden', request_id: 'test' },
      { status: 403 },
    );
  }) as typeof fetch;
  try {
    await expect(readMicrosoftLearnStatus(controller.signal)).rejects.toThrow();
    await expect(changeMicrosoftLearnConnection('connect', controller.signal)).rejects.toThrow(
      'CSRF',
    );
    csrfToken = csrf;
    await expect(changeMicrosoftLearnConnection('connect', controller.signal)).rejects.toThrow(
      'HTTP 403',
    );
    cancelAfterMe = true;
    await expect(
      changeMicrosoftLearnConnection('connect', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toEqual([base, '/api/v1/me', '/api/v1/me', `${base}/connect`, '/api/v1/me']);
  } finally {
    globalThis.fetch = original;
  }
});
