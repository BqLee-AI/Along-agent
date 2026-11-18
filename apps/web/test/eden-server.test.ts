import { describe, expect, mock, test } from 'bun:test';

mock.module('server-only', () => ({}));
mock.module('next/headers', () => ({ cookies: async () => new Headers() }));
class LoginRedirect extends Error {}
mock.module('next/navigation', () => ({
  redirect: (location: string) => {
    throw new LoginRedirect(location);
  },
}));

// Load the RSC boundary only after installing its Next-only test modules.
const { apiGet } = await import('../src/shared/http/server');

describe('protected server reads', () => {
  test('redirects on 401 without waiting for the response body', async () => {
    const originalFetch = globalThis.fetch;
    const cancelled = Promise.withResolvers<void>();
    const response = new Response(new ReadableStream({ cancel: () => cancelled.resolve() }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    globalThis.fetch = new Proxy(originalFetch, { apply: () => Promise.resolve(response) });
    try {
      await expect(apiGet((api) => api.api.v1.tasks.get(), '/tasks')).rejects.toThrow(
        new LoginRedirect('/login?returnTo=%2Ftasks'),
      );
      await cancelled.promise;
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
