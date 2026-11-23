import { expect, test } from 'bun:test';
import { createApp } from '../../src/http/app.js';
import { createIntegrationDatabase, seedAdmittedSession } from './setup.js';

const base = 'http://localhost:3000/api/v1/connections/microsoft-learn';

test('fixed public connector starts empty, connects only its owner and disconnects without upstream calls', async () => {
  const db = await createIntegrationDatabase();
  const priorSecret = process.env.BETTER_AUTH_SECRET;
  const priorOrigin = process.env.APP_ORIGIN;
  process.env.BETTER_AUTH_SECRET = 'synthetic-remote-mcp-connection-test-only';
  process.env.APP_ORIGIN = 'http://localhost:3000';
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      upstreamCalls++;
      throw new Error('connection status and changes must not contact Microsoft');
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const first = await seedAdmittedSession(db.pool);
    const second = await seedAdmittedSession(db.pool);
    const app = createApp({ pool: db.pool });
    const headers = (session: typeof first) => ({
      cookie: `better-auth.session_token=${encodeURIComponent(session.token)}`,
      origin: 'http://localhost:3000',
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json',
    });
    const get = (session: typeof first) =>
      app.handle(new Request(base, { headers: headers(session) }));
    const change = (action: string, body: unknown = {}) =>
      app.handle(
        new Request(`${base}/${action}`, {
          method: 'POST',
          headers: headers(first),
          body: JSON.stringify(body),
        }),
      );
    const idle = await get(first);
    expect(idle.status).toBe(200);
    expect(idle.headers.get('cache-control')).toBe('no-store');
    expect(await idle.json()).toMatchObject({ data: { state: 'idle' } });
    expect((await app.handle(new Request(base))).status).toBe(401);
    expect(
      (await app.handle(new Request(`${base}/connect`, { method: 'POST', body: '{}' }))).status,
    ).toBe(401);
    const wrongOrigin = await app.handle(
      new Request(`${base}/connect`, {
        method: 'POST',
        headers: { ...headers(first), origin: 'https://foreign.invalid' },
        body: '{}',
      }),
    );
    expect(wrongOrigin.status).toBe(403);
    const noCsrf = headers(first);
    delete (noCsrf as Partial<typeof noCsrf>)['x-csrf-token'];
    expect(
      (
        await app.handle(
          new Request(`${base}/connect`, { method: 'POST', headers: noCsrf, body: '{}' }),
        )
      ).status,
    ).toBe(403);
    expect((await change('connect', { url: 'https://foreign.invalid' })).status).toBe(400);
    expect(await (await get(first)).json()).toMatchObject({ data: { state: 'idle' } });
    expect(await (await change('connect')).json()).toMatchObject({ data: { state: 'connected' } });
    expect(await (await get(second)).json()).toMatchObject({ data: { state: 'idle' } });
    const generation = (
      await db.pool.query('SELECT generation FROM microsoft_learn_connections WHERE owner_id=$1', [
        first.userId,
      ])
    ).rows[0].generation;
    await change('connect');
    expect(
      (
        await db.pool.query(
          'SELECT generation FROM microsoft_learn_connections WHERE owner_id=$1',
          [first.userId],
        )
      ).rows[0].generation,
    ).toBe(generation);
    expect(await (await change('disconnect')).json()).toMatchObject({ data: { state: 'idle' } });
    await change('connect');
    expect(
      (
        await db.pool.query(
          'SELECT generation FROM microsoft_learn_connections WHERE owner_id=$1',
          [first.userId],
        )
      ).rows[0].generation,
    ).not.toBe(generation);
    expect(upstreamCalls).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    if (priorSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = priorSecret;
    if (priorOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = priorOrigin;
    await db.close();
  }
});
