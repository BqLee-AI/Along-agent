import { afterEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { handleRequest } from './helpers/http-app.js';

const servers: Server[] = [];
const previous = process.env.ALONG_LOCAL_MODEL_PROXY_TOKEN;
afterEach(async () => {
  if (previous === undefined) delete process.env.ALONG_LOCAL_MODEL_PROXY_TOKEN;
  else process.env.ALONG_LOCAL_MODEL_PROXY_TOKEN = previous;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
});

test('model writes trust only the configured local proxy, never forwarded protocol headers', async () => {
  process.env.ALONG_LOCAL_MODEL_PROXY_TOKEN = 'a'.repeat(64);
  const server = createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '172.20.0.1', configurable: true });
    Object.defineProperty(req.socket, 'localAddress', { value: '172.20.0.2', configurable: true });
    void handleRequest(req, res, {
      pool: null,
      resolveActor: async () => ({
        ownerId: 'owner',
        sessionId: null,
        displayName: '',
        timezoneId: null,
      }),
    }).catch(() => res.destroy());
  });
  servers.push(server);
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/model-providers`;
  const send = (headers: Record<string, string>) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ name: 'fixture' }),
    });
  expect((await send({ 'x-forwarded-proto': 'https' })).status).toBe(403);
  expect((await send({ 'x-along-local-model-proxy': 'wrong' })).status).toBe(403);
  delete process.env.ALONG_LOCAL_MODEL_PROXY_TOKEN;
  expect((await send({ 'x-along-local-model-proxy': 'a'.repeat(64) })).status).toBe(403);
  process.env.ALONG_LOCAL_MODEL_PROXY_TOKEN = 'a'.repeat(64);
  expect((await send({ 'x-along-local-model-proxy': 'a'.repeat(64) })).status).toBe(503);
});
