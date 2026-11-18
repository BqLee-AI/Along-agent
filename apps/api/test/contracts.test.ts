import { afterAll, describe, expect, it } from 'bun:test';
import { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HealthSchema } from '@along/contracts';
import { handleRequest } from './helpers/http-app.js';
import { serve } from '../src/http/server.js';

const server = serve({ port: 0, deps: { pool: null, tzdbVersion: '2024a' } });

afterAll(() => {
  server.close();
});
function baseUrl(): string {
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function invokeInProcess(): Promise<{ status: number; body: unknown }> {
  const { promise, resolve } = Promise.withResolvers<{
    status: number;
    body: unknown;
  }>();
  let status = 0;
  let payload = '';
  const req = { method: 'GET', url: '/healthz', headers: {} } as unknown as IncomingMessage;
  const res = {
    writeHead(s: number) {
      status = s;
    },
    end(b: string) {
      payload = b;
      resolve({ status, body: JSON.parse(payload) });
    },
  } as unknown as ServerResponse;
  await handleRequest(req, res, { pool: null, tzdbVersion: '2024a' });
  return promise;
}

describe('contracts dual-run: /healthz', () => {
  it('in-process handler shape', async () => {
    const { status, body } = await invokeInProcess();
    expect(status).toBe(200);
    expect(HealthSchema.parse(body)).toEqual({ status: 'ok' });
  });

  it('over HTTP', async () => {
    const response = await fetch(`${baseUrl()}/healthz`);
    expect(response.status).toBe(200);
    expect(HealthSchema.parse(await response.json())).toEqual({ status: 'ok' });
  });
});
