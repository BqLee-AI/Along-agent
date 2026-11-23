import { describe, expect, it } from 'bun:test';
import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeWebResponse } from '../src/http/transport/response.js';
import { closeUnreadRequest } from '../src/http/transport/unread-upload.js';

const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0, 0xff, 0x0d, 0x0a]);
const cookies = ['first=session; Path=/; HttpOnly', 'second=state; Path=/; HttpOnly'];

describe('HTTP finite response transport', () => {
  it.each([false, true])('preserves exact bytes and cookies (early close: %s)', async (close) => {
    const server = createServer((req, res) => {
      const headers = new Headers({
        'content-type': 'application/octet-stream',
        'content-length': String(close ? bytes.length + 1 : bytes.length),
      });
      for (const cookie of cookies) headers.append('set-cookie', cookie);
      if (close) closeUnreadRequest(req, res);
      void writeWebResponse(new Response(bytes, { headers }), res).catch(() => res.destroy());
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const { port } = server.address() as AddressInfo;

    try {
      const { promise, resolve, reject } = Promise.withResolvers<{
        headers: IncomingHttpHeaders;
        body: Buffer;
      }>();
      const req = request({ host: '127.0.0.1', port, method: close ? 'POST' : 'GET' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('error', reject);
        res.once('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      });
      // Real socket deadline guards against accidentally waiting for the unfinished upload.
      req.setTimeout(1500, () => req.destroy(new Error('response did not finish')));
      req.once('error', reject);
      if (close) req.write('unfinished upload');
      else req.end();
      const reply = await promise;
      expect(reply.body).toEqual(bytes);
      expect(reply.headers['content-length']).toBe(String(bytes.length));
      expect(reply.headers['transfer-encoding']).toBeUndefined();
      expect(reply.headers['set-cookie']).toEqual(cookies);
      if (close) expect(reply.headers.connection).toBe('close');
    } finally {
      const stopped = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await stopped;
    }
  });
});
