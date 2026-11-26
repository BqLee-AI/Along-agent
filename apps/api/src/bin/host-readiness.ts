import { createServer } from 'node:http';
import { createPool } from '../db/pool.js';
import { loadTimeContext } from '../features/time/public.js';
import { readiness } from '../http/health/model.js';

const socketPath = process.argv[2];
if (!socketPath) throw new Error('missing host capability socket path');
const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? createPool({ connectionString, connectionTimeoutMillis: 1_500, statement_timeout: 1_500 })
  : null;
const time = loadTimeContext(process.env.TZDB_VERSION);
const server = createServer(async (request, response) => {
  if (request.method !== 'GET' || request.url !== '/readiness') {
    response.writeHead(404).end();
    return;
  }
  const requestId = request.headers['x-request-id'];
  if (typeof requestId !== 'string' || !requestId || requestId.length > 200) {
    response.writeHead(400).end();
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
    await pool?.end();
    process.exit(0);
  });
}
process.stdin.on('end', stop).resume();
process.on('SIGTERM', stop);
