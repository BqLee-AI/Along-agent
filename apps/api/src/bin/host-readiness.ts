import { createServer, type ServerResponse } from 'node:http';
import { httpStatusForError } from '@along/contracts';
import { createRunDriver } from '../agent/execution/driver/driver.js';
import { createRoutingRuntime } from '../agent/routing/index.js';
import { loadHarnessServices } from '../bootstrap/harness-services.js';
import { createPool } from '../db/pool.js';
import { createUserModelTransport } from '../features/model-providers/public.js';
import { loadTimeContext } from '../features/time/public.js';
import { readiness } from '../http/health/model.js';
import { failEnvelope } from '../http/errors.js';
import { toWebRequest } from '../http/transport/request.js';
import { ApplicationError, validationError } from '../platform/errors.js';
import { createHostBusinessCapability } from './host-business-capability.js';
import { createHostReminderActions } from './host-reminder-actions.js';
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
const apiPool = role === 'all' || role === 'api' ? createPool() : null;
const driver = apiPool ? createRunDriver(apiPool) : undefined;
const business = createHostBusinessCapability({
  pool: apiPool,
  timeContext: time,
  harness: apiPool ? loadHarnessServices() : undefined,
  modelTransport: createUserModelTransport,
  routing: apiPool ? createRoutingRuntime() : undefined,
  runDriver: driver,
});
const actions = createHostReminderActions({ pool: apiPool });

function sendCapabilityJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  requestId: string,
) {
  const body = JSON.stringify(value);
  res
    .writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-request-id': requestId,
    })
    .end(body);
}

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
  if (
    request.method === 'POST' &&
    (path.startsWith('/api/v1/') || path === '/business/step' || path === '/harness/step')
  ) {
    try {
      const web = toWebRequest(request, new URL(path, 'http://localhost'));
      if (
        web.headers.get('x-along-host-operation') === 'admit' &&
        new URL(web.url).pathname === '/api/v1/conversations/messages'
      ) {
        sendCapabilityJson(response, 200, await business.open(web), requestId);
      } else if (path === '/business/step' || path === '/harness/step') {
        const lease = web.headers.get('x-run-capability');
        const operation = web.headers.get('x-run-operation');
        if (!lease || !operation) throw validationError('missing Run operation');
        const input: unknown = await web.json();
        const result =
          path === '/business/step'
            ? await business.step(lease, operation, input)
            : await business.harnessStep(lease, operation, input);
        sendCapabilityJson(response, 200, result, requestId);
      } else {
        const result = await actions(web);
        if (result) {
          const body = await result.text();
          response
            .writeHead(result.status, {
              ...Object.fromEntries(result.headers),
              'content-length': Buffer.byteLength(body),
            })
            .end(body);
        } else {
          response.writeHead(404, { 'content-length': 0 }).end();
        }
      }
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      const failure =
        error instanceof ApplicationError
          ? error
          : new ApplicationError(500, 'INTERNAL_ERROR', 'internal error');
      sendCapabilityJson(
        response,
        httpStatusForError(failure.code),
        failEnvelope(failure, requestId),
        requestId,
      );
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
    await business.close();
    await driver?.shutdown();
    await apiPool?.end();
    await workerPool?.end();
    await pool?.end();
    process.exit(0);
  });
}
process.stdin.on('end', stop).resume();
process.on('SIGTERM', stop);
