// Real HTTP child process used only by approvals revision regression tests.
// DATABASE_URL is the isolated fixture URL, never the ambient public schema.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { handleRequest } from '../helpers/http-app.js';
import { loadTimeContext } from '../../src/features/time/context.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const timeContext = loadTimeContext('fixture-v1');
const server = createServer((req, res) => {
  if (process.env.DROP_REVISION_RESPONSE === '1' && req.url?.endsWith('/actions/revise')) {
    const end = res.end.bind(res);
    res.end = ((chunk: unknown) => {
      const payload =
        typeof chunk === 'string' || Buffer.isBuffer(chunk) ? JSON.parse(chunk.toString()) : null;
      if (payload?.code === 0) {
        // The real handler committed; hold the body until the client disconnects.
        process.stdout.write(`${JSON.stringify({ stage: 'revision_committed' })}\n`);
        return res;
      }
      return end(chunk as string);
    }) as typeof res.end;
  }
  void handleRequest(req, res, { pool, timeContext, tzdbVersion: 'fixture-v1' });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: (server.address() as AddressInfo).port })}\n`);
});
process.on('SIGTERM', () => {
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
  server.closeAllConnections();
});
