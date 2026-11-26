import { createServer } from 'node:http';
import { createPool } from '../db/pool.js';
import { loadTimeContext } from '../features/time/public.js';
import { readiness } from '../http/health/model.js';
import { createHostWorker } from './host-worker.js';

const socketPath = process.argv[2];
if (!socketPath) throw new Error('missing host capability socket path');
const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? createPool({ connectionString, connectionTimeoutMillis: 1_500, statement_timeout: 1_500 })
  : null;
const time = loadTimeContext(process.env.TZDB_VERSION);
const role = process.argv[3];
const workerPool = role === 'all' || role === 'worker' ? createPool() : null;
const worker = createHostWorker(workerPool);
const server = createServer(async (request, response) => {
  const path = request.url ?? '';
  const requestId = request.headers['x-request-id'];
  if (typeof requestId !== 'string' || !requestId || requestId.length > 200) {
    response.writeHead(400).end();
    return;
  }
  if (request.method === 'POST' && path.startsWith('/worker/')) {
    const workerId = request.headers['x-worker-id'];
    if (!workerPool || typeof workerId !== 'string') {
      response.writeHead(503).end();
      return;
    }
    try {
      await worker.runPhase(path.slice('/worker/'.length), workerId);
      response.writeHead(204, { 'x-request-id': requestId }).end();
    } catch (error) {
      console.error('[host worker]', path, error);
      response.writeHead(500, { 'x-request-id': requestId }).end();
    }
    return;
  }
  if (request.method !== 'GET' || path !== '/readiness') {
    response.writeHead(404).end();
    return;
  }
  const result = await readiness(pool, time);
  if (response.destroyed) return;
  const body = JSON.stringify(result);
  response.writeHead(result.status === 'ok' ? 200 : 503, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-request-id': requestId,
  });
  response.end(body);
});
server.listen(socketPath);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await worker.stop();
    await workerPool?.end();
    await pool?.end();
    process.exit(0);
  });
}
process.stdin.on('end', stop).resume();
process.on('SIGTERM', stop);
