import { createServer, type ServerResponse } from 'node:http';
import { httpStatusForError } from '@along/contracts';
import { createRunDriver } from '../agent/execution/driver/driver.js';
import { createRoutingRuntime } from '../agent/routing/index.js';
import { createConfiguredAccountService } from '../bootstrap/identity.js';
import { loadHarnessServices } from '../bootstrap/harness-services.js';
import { createPool } from '../db/pool.js';
import { conversationMemorySources } from '../features/conversations/public.js';
import { createInvitedAccountService } from '../features/identity/public.js';
import { createMemoryService } from '../features/memory/public.js';
import { loadWorkspaceRegistry } from '../features/workspaces/public.js';
import { createUserModelTransport } from '../features/model-providers/public.js';
import { loadTimeContext } from '../features/time/public.js';
import { readiness } from '../http/health/model.js';
import { failEnvelope, okEnvelope } from '../http/errors.js';
import { toWebRequest } from '../http/transport/request.js';
import { ApplicationError, validationError } from '../platform/errors.js';
import { finiteRequest, writeFiniteReply } from './finite-http.js';
import { createHostAccount } from './host-account.js';
import { createHostBusinessCapability } from './host-business-capability.js';
import { createHostProductRoutes } from './host-product-routes.js';
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
if (apiPool) await loadWorkspaceRegistry();
const product = createHostProductRoutes({
  pool: apiPool,
  timeContext: time,
  modelTransport: createUserModelTransport,
  memoryService: apiPool
    ? createMemoryService({ pool: apiPool, sources: conversationMemorySources })
    : undefined,
});
const account = createHostAccount({
  pool: apiPool,
  timeContext: time,
  modelTransport: createUserModelTransport,
  ...(apiPool
    ? {
        accountService: createConfiguredAccountService(apiPool),
        invitedAccountService: createInvitedAccountService(apiPool),
      }
    : {}),
});

function sendCapabilityJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  requestId: string,
  headers?: Record<string, string>,
) {
  const body = JSON.stringify(value);
  res
    .writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-request-id': requestId,
      ...headers,
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
  const operation = request.headers['x-along-host-operation'];
  if (operation === 'account' || operation === 'product') {
    const abort = new AbortController();
    const onClose = () => abort.abort();
    response.once('close', onClose);
    try {
      const web = toWebRequest(request, new URL(path, 'http://localhost'), abort.signal);
      const result =
        operation === 'account' ? await account(web) : await product(finiteRequest(web));
      if (result) await writeFiniteReply(result, response);
      else response.writeHead(404, { 'content-length': 0 }).end();
    } catch {
      if (!response.destroyed && !response.headersSent) {
        const failure = new ApplicationError(503, 'NOT_READY', 'service not ready');
        sendCapabilityJson(response, 503, failEnvelope(failure, requestId), requestId);
      }
    } finally {
      response.off('close', onClose);
    }
    return;
  }
  const conversationEntry = request.headers['x-along-conversation-operation'];
  if (
    (request.method === 'POST' && (path === '/business/step' || path === '/harness/step')) ||
    (typeof conversationEntry === 'string' && path.startsWith('/api/v1/conversations'))
  ) {
    try {
      const web = toWebRequest(request, new URL(path, 'http://localhost'));
      if (typeof conversationEntry === 'string' && path.startsWith('/api/v1/conversations')) {
        const opened = await business.open(web, conversationEntry);
        if ('data' in opened) {
          sendCapabilityJson(
            response,
            200,
            okEnvelope(opened.data, requestId),
            requestId,
            opened.native ? { 'x-native-handoff': opened.native } : undefined,
          );
        } else {
          sendCapabilityJson(response, 200, opened, requestId, { 'x-run-stream': '1' });
        }
      } else if (path === '/business/step' || path === '/harness/step') {
        const lease = web.headers.get('x-run-capability');
        const operation = web.headers.get('x-run-operation');
        if (!lease || !operation) throw validationError('missing Run operation');
        const input: unknown = await web.json();
        if (path === '/business/step') {
          await business.step(lease, operation, input, (value) => {
            if (response.destroyed || response.writableEnded) return false;
            sendCapabilityJson(response, 200, value, requestId);
            return true;
          });
        } else {
          sendCapabilityJson(
            response,
            200,
            await business.harnessStep(lease, operation, input),
            requestId,
          );
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
