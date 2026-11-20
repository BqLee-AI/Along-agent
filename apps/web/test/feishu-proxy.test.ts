import { expect, test } from 'bun:test';
import type { NextRequest } from 'next/server';
import { GET, POST } from '../src/app/api/[...path]/route';

const botPath = ['v1', 'office', 'feishu', 'bot'];

test('forwards actual bot session, origin and CSRF but never caches scan data', async () => {
  const original = globalThis.fetch;
  const observed: unknown[] = [];
  globalThis.fetch = (async (url, init) => {
    const headers = new Headers(init?.headers);
    observed.push({
      path: new URL(String(url)).pathname,
      method: init?.method,
      cookie: headers.get('cookie'),
      origin: headers.get('origin'),
      csrf: headers.get('x-csrf-token'),
      redirect: init?.redirect,
    });
    return Response.json(
      { data: { state: 'preparing' } },
      {
        headers: { 'cache-control': 'public', location: 'https://accounts.example.test/' },
      },
    );
  }) as typeof fetch;
  try {
    const status = await GET(
      new Request('http://web.test/api/v1/office/feishu/bot', {
        headers: { cookie: 'session=synthetic' },
      }) as NextRequest,
      { params: Promise.resolve({ path: botPath }) },
    );
    const action = await POST(
      new Request('http://web.test/api/v1/office/feishu/bot/scan', {
        method: 'POST',
        headers: {
          cookie: 'session=synthetic',
          origin: 'http://web.test',
          'x-csrf-token': 'synthetic-csrf',
        },
      }) as NextRequest,
      { params: Promise.resolve({ path: [...botPath, 'scan'] }) },
    );
    for (const response of [status, action]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('location')).toBeNull();
      expect(await response.json()).toEqual({ data: { state: 'preparing' } });
    }
    expect(observed).toEqual([
      {
        path: '/api/v1/office/feishu/bot',
        method: 'GET',
        cookie: 'session=synthetic',
        origin: null,
        csrf: null,
        redirect: 'manual',
      },
      {
        path: '/api/v1/office/feishu/bot/scan',
        method: 'POST',
        cookie: 'session=synthetic',
        origin: 'http://web.test',
        csrf: 'synthetic-csrf',
        redirect: 'manual',
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
