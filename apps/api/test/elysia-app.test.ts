import { EnvelopeSchema } from '@along/contracts';
import { describe, expect, it } from 'bun:test';
import { createApp } from '../src/http/app.js';
import type { Actor } from '../src/features/identity/session/actor.js';
import { attachConnection } from '../src/http/transport/metadata.js';
const actor: Actor = {
  ownerId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  displayName: 'HTTP owner',
  timezoneId: null,
};
function upload(path: string, body = 'not JSON', headers: Record<string, string> = {}) {
  let reads = 0;
  const request = new Request('http://localhost' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
  });
  return { request, reads: () => reads };
}
describe('Elysia application admission', () => {
  it('reports office summary disabled by default and requires an actor and CSRF', async () => {
    const previous = process.env.ALONG_NATIVE_OFFICE_ADMISSION;
    delete process.env.ALONG_NATIVE_OFFICE_ADMISSION;
    try {
      const capability = 'http://localhost/api/v1/model-providers/office-capability';
      const anonymous = createApp({ pool: null, resolveActor: async () => null });
      const signed = createApp({ pool: null, resolveActor: async () => actor });
      expect((await anonymous.handle(new Request(capability))).status).toBe(401);

      const response = await signed.handle(new Request(capability));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(EnvelopeSchema.parse(await response.json()).data).toEqual({ enabled: false });

      const path = '/api/v1/model-providers/actions/summarize-notes';
      const unauthenticated = upload(path);
      expect((await anonymous.handle(unauthenticated.request)).status).toBe(401);
      expect(unauthenticated.reads()).toBe(0);
      const noCsrf = upload(path);
      const forbidden = await signed.handle(noCsrf.request);
      expect(forbidden.status).toBe(403);
      expect(noCsrf.reads()).toBe(0);
      expect(EnvelopeSchema.parse(await forbidden.json()).error?.details).toMatchObject({
        reason: 'CSRF_MISMATCH',
      });
    } finally {
      if (previous === undefined) delete process.env.ALONG_NATIVE_OFFICE_ADMISSION;
      else process.env.ALONG_NATIVE_OFFICE_ADMISSION = previous;
    }
  });
  it('uses the actual Request without consuming an unauthenticated upload', async () => {
    const input = upload('/api/v1/model-providers');
    const response = await createApp({ pool: null, resolveActor: async () => null }).handle(
      input.request,
    );
    expect(response.status).toBe(401);
    expect(input.reads()).toBe(0);
    expect(EnvelopeSchema.parse(await response.json()).error?.code).toBe('UNAUTHENTICATED');
  });
  it('matches before CSRF and body parsing for authenticated unknown writes', async () => {
    const input = upload('/api/v1/model-providers/not/a/route');
    const response = await createApp({ pool: null, resolveActor: async () => actor }).handle(
      input.request,
    );
    expect(response.status).toBe(404);
    expect(input.reads()).toBe(0);
    expect(EnvelopeSchema.parse(await response.json()).error?.code).toBe('NOT_FOUND');
  });
  it('rejects CSRF before declared length, JSON and connection checks', async () => {
    const input = upload('/api/v1/model-providers', 'not JSON', { 'content-length': '131073' });
    const response = await createApp({ pool: null, resolveActor: async () => actor }).handle(
      input.request,
    );
    expect(response.status).toBe(403);
    expect(input.reads()).toBe(0);
    expect(EnvelopeSchema.parse(await response.json()).error?.details).toMatchObject({
      reason: 'CSRF_MISMATCH',
    });
  });
  it('does not allow anonymous account paths to bypass the exact route match', async () => {
    const input = upload('/api/v1/auth/sign-up/email');
    const response = await createApp({ pool: null }).handle(input.request);
    expect(response.status).toBe(404);
    expect(input.reads()).toBe(0);
  });
  it('keeps encoded and trailing-slash static paths distinct', async () => {
    const app = createApp({ pool: null });
    for (const path of ['/api/v1/%6de', '/healthz/'])
      expect((await app.handle(new Request('http://localhost' + path))).status).toBe(404);
    const response = await app.handle(
      new Request('http://localhost/healthz', { headers: { 'x-request-id': 'elysia-contract' } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('elysia-contract');
    expect(await response.json()).toEqual({ status: 'ok' });
  });
  it('requires trustworthy peer metadata before a model write reads its body', async () => {
    const input = upload('/api/v1/model-providers');
    const response = await createApp({
      pool: null,
      resolveActor: async () => ({ ...actor, sessionId: null }),
    }).handle(input.request);
    expect(response.status).toBe(403);
    expect(input.reads()).toBe(0);
    expect(EnvelopeSchema.parse(await response.json()).msg).toBe('secure connection required');
  });
  it('maps JSON parsing to400, not framework422, after trusted admission', async () => {
    const input = upload('/api/v1/model-providers');
    attachConnection(input.request, {
      remoteAddress: '127.0.0.1',
      localAddress: '127.0.0.1',
      encrypted: false,
    });
    const response = await createApp({
      pool: null,
      resolveActor: async () => ({ ...actor, sessionId: null }),
    }).handle(input.request);
    expect(response.status).toBe(400);
    expect(EnvelopeSchema.parse(await response.json()).error?.code).toBe('VALIDATION_ERROR');
  });
});
