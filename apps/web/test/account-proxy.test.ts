import { describe, expect, it } from 'bun:test';
import type { NextRequest } from 'next/server';
import { GET, POST } from '../src/app/api/[...path]/route';

describe('account proxy security and response boundaries', () => {
  it('preserves every Cookie, actual Origin and retry metadata without trusting forwarding headers', async () => {
    const original = globalThis.fetch;
    const observations: Array<{
      origin: string | null;
      forwarded: string | null;
      cookie: string | null;
      body: string;
    }> = [];
    globalThis.fetch = (async (_url, init) => {
      const headers = new Headers(init?.headers);
      const body = await new Response(init?.body).text();
      observations.push({
        origin: headers.get('origin'),
        forwarded: headers.get('x-forwarded-for'),
        cookie: headers.get('cookie'),
        body,
      });
      const result = new Headers({ 'cache-control': 'public', 'retry-after': '12' });
      result.append('set-cookie', 'session=first; Path=/; HttpOnly');
      result.append('set-cookie', 'csrf=second; Path=/; SameSite=Lax');
      return new Response('result', { status: 429, headers: result });
    }) as typeof fetch;
    try {
      const request = new Request('http://web.test/api/v1/auth/password/change', {
        method: 'POST',
        headers: {
          origin: 'http://actual-origin.test',
          cookie: 'session=old; csrf=old',
          'x-forwarded-for': 'spoofed',
          'content-type': 'application/json',
        },
        body: '{"current_password":" password ","new_password":" new password "}',
      });
      const result = await POST(request as NextRequest, {
        params: Promise.resolve({ path: ['v1', 'auth', 'password', 'change'] }),
      });
      expect(await result.text()).toBe('result');
      expect(observations).toEqual([
        {
          origin: 'http://actual-origin.test',
          forwarded: null,
          cookie: 'session=old; csrf=old',
          body: '{"current_password":" password ","new_password":" new password "}',
        },
      ]);
      expect(result.status).toBe(429);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(result.headers.get('retry-after')).toBe('12');
      expect(result.headers.getSetCookie()).toEqual([
        'session=first; Path=/; HttpOnly',
        'csrf=second; Path=/; SameSite=Lax',
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
  it('never synthesizes missing Origin and keeps GET bodyless and no-store', async () => {
    const original = globalThis.fetch;
    const observations: Array<{
      origin: string | null;
      method: string | undefined;
      body: BodyInit | null | undefined;
    }> = [];
    globalThis.fetch = (async (_url, init) => {
      observations.push({
        origin: new Headers(init?.headers).get('origin'),
        method: init?.method,
        body: init?.body,
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      const result = await GET(new Request('http://web.test/api/v1/auth/account') as NextRequest, {
        params: Promise.resolve({ path: ['v1', 'auth', 'account'] }),
      });
      expect(observations).toEqual([{ origin: null, method: 'GET', body: undefined }]);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(result.status).toBe(204);
    } finally {
      globalThis.fetch = original;
    }
  });
});
