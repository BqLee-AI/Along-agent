import { expect, test } from 'bun:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { EnvelopeSchema } from '@along/contracts';
import { handleRequest } from './helpers/http-app.js';

test('document decisions authenticate before parsing an oversized request body', async () => {
  const server = createServer((req, res) => {
    void handleRequest(req, res, { pool: null, resolveActor: async () => null });
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing HTTP address');
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/document-approvals/00000000-0000-4000-8000-000000000001/actions/confirm`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(131073),
      },
    );
    const body = EnvelopeSchema.parse(await response.json());
    expect(response.status).toBe(401);
    expect(body.error?.code).toBe('UNAUTHENTICATED');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
