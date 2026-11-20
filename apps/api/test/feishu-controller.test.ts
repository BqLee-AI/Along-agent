import { EnvelopeSchema } from '@along/contracts';
import { expect, test } from 'bun:test';
import { createApp } from '../src/http/app.js';

const scheme = 'http://localhost:3000';
const base = '/api/v1/office/feishu';
const actor = {
  ownerId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  displayName: 'Feishu connector test owner',
  timezoneId: null,
};

test('requires a signed session for bot status and actions', async () => {
  const anonymous = createApp({ pool: null, resolveActor: async () => null });
  const unsigned = createApp({
    pool: null,
    resolveActor: async () => ({ ...actor, sessionId: null }),
  });
  for (const [path, method] of [
    ['/bot', 'GET'],
    ['/bot/scan', 'POST'],
    ['/bot/cancel', 'POST'],
    ['/bot/disconnect', 'POST'],
  ]) {
    expect((await anonymous.handle(new Request(scheme + base + path, { method }))).status).toBe(
      401,
    );
    expect((await unsigned.handle(new Request(scheme + base + path, { method }))).status).toBe(403);
  }
});

test('requires exact origin and CSRF before any bot action', async () => {
  const app = createApp({ pool: null, resolveActor: async () => actor });
  const origin = process.env.APP_ORIGIN ?? scheme;
  const foreign = await app.handle(
    new Request(`${scheme}${base}/bot/scan`, {
      method: 'POST',
      headers: { origin: 'https://untrusted.example' },
    }),
  );
  expect(foreign.status).toBe(403);
  expect(EnvelopeSchema.parse(await foreign.json()).error?.message).toBe('Origin mismatch');
  for (const action of ['scan', 'cancel', 'disconnect']) {
    const response = await app.handle(
      new Request(`${scheme}${base}/bot/${action}`, { method: 'POST', headers: { origin } }),
    );
    expect(response.status).toBe(403);
    expect(EnvelopeSchema.parse(await response.json()).error?.details).toMatchObject({
      reason: 'CSRF_MISMATCH',
    });
  }
});

test('legacy user OAuth routes are not registered', async () => {
  const app = createApp({ pool: null, resolveActor: async () => actor });
  const origin = process.env.APP_ORIGIN ?? scheme;
  for (const [path, method] of [
    ['/authorize', 'POST'],
    ['/callback?state=synthetic&code=synthetic', 'GET'],
    ['/pending', 'GET'],
    ['/confirm', 'POST'],
    ['/disconnect', 'POST'],
  ]) {
    const response = await app.handle(
      new Request(scheme + base + path, { method, headers: { origin } }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
    expect(EnvelopeSchema.parse(await response.json()).error?.code).toBe('NOT_FOUND');
  }
});
