import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { createActorResolver, csrfTokenFor, verifyCsrf, type ActorResolver } from './auth.js';
import {
  csrfMismatch,
  HttpError,
  validationError,
  failEnvelope,
  notFound,
  requestIdOf,
  sendJson,
  okEnvelope,
  unauthorized,
} from './errors.js';
import { handleApprovalRoute } from '../modules/approvals/routes.js';
import { handleDocumentApprovalRoute } from '../modules/approvals/document-routes.js';
import { handleWorkspaceRoute } from '../modules/workspaces/routes.js';
import { handleConversationRoute } from '../modules/conversations/routes.js';
import { handleTaskRoute } from '../modules/tasks/routes.js';
import { handleBriefRoute } from '../modules/brief/routes.js';
import { loadTimeContext, type TimeContext } from '../modules/time/context.js';
import type { HarnessServices } from '../modules/conversations/harness-process.js';
import type { RoutingRuntime } from '../modules/conversations/routing/index.js';
import { createAccountService, type AccountService } from '../modules/identity/account-service.js';
import { handleAccountRoute, isKnownAccountRoute } from '../modules/identity/routes.js';
import {
  createInvitedAccountService,
  type InvitedAccountService,
} from '../modules/identity/invited-service.js';
import { notReady } from './errors.js';

export interface AppDeps {
  pool: Pool | null;
  resolveActor?: ActorResolver;
  tzdbVersion?: string;
  timeContext?: TimeContext;
  harness?: HarnessServices | null;
  routing?: RoutingRuntime;
  accountService?: AccountService;
  invitedAccountService?: InvitedAccountService;
}

interface TzdbOnlyOpts {
  tzdbVersion: string | undefined;
}

function isAppDeps(opts: TzdbOnlyOpts | AppDeps): opts is AppDeps {
  return 'pool' in opts || 'resolveActor' in opts;
}

const MAX_BODY_BYTES = 131072;

function closeUnreadRequest(req: IncomingMessage, res: ServerResponse): void {
  if (!req.socket || req.readableEnded) return;
  req.pause();
  res.shouldKeepAlive = false;
  res.setHeader('connection', 'close');
  // Flush the finite response before destroying an unfinished upload. Do not
  // resume/drain an attacker-controlled stream or wait for its end.
  const close = () => req.destroy();
  req.once('error', () => {});
  res.once('finish', close);
  res.once('close', close);
}

function readBody(req: IncomingMessage): Promise<{ body: unknown } | null> {
  if (req.destroyed) return Promise.resolve(null);
  const { promise, resolve, reject } = Promise.withResolvers<{ body: unknown } | null>();
  const chunks: Buffer[] = [];
  let bytes = 0;
  function cleanup() {
    chunks.length = 0;
    req.off('data', onData);
    req.off('end', onEnd);
    req.off('error', onInterrupted);
    req.off('close', onInterrupted);
  }
  function onData(chunk: Buffer) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      req.pause();
      cleanup();
      reject(new HttpError(413, 413, 'PAYLOAD_TOO_LARGE', 'request body too large'));
      return;
    }
    chunks.push(chunk);
  }
  function onEnd() {
    try {
      const body: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
      cleanup();
      resolve({ body });
    } catch {
      cleanup();
      reject(validationError('invalid JSON body'));
    }
  }
  function onInterrupted() {
    cleanup();
    resolve(null);
  }
  req.on('data', onData);
  req.once('end', onEnd);
  req.once('error', onInterrupted);
  req.once('close', onInterrupted);
  return promise;
}

// Async handler with injected deps (pool + actor resolver).
// Keeps /healthz + /readyz behavior from S0.5; /me and the brief/tasks/
// approvals/conversation routes are owner-scoped behind the actor resolver.
async function dispatchRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: TzdbOnlyOpts | AppDeps,
): Promise<void> {
  const requestId = requestIdOf(req);
  // All module envelopes and SSE frames reuse this normalized transport id.
  req.headers['x-request-id'] = requestId;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;
  const deps: AppDeps = isAppDeps(opts) ? opts : { pool: null, tzdbVersion: opts.tzdbVersion };
  const tzdbVersion = deps.tzdbVersion;
  const timeContext = deps.timeContext ?? loadTimeContext(tzdbVersion);
  let resolveActor = deps.resolveActor ?? createActorResolver({ pool: deps.pool });
  let body: unknown;
  if (req.method !== 'GET' && req.method !== 'POST') closeUnreadRequest(req, res);
  if (pathname.startsWith('/api/v1/auth/')) {
    if (!isKnownAccountRoute(req.method, pathname)) throw notFound();
    if (!deps.pool && !deps.accountService) throw notReady();
    const service = deps.accountService ?? createAccountService(deps.pool!);
    const result = await handleAccountRoute(
      req,
      res,
      pathname,
      {
        service,
        invitedService:
          deps.invitedAccountService ??
          (deps.pool ? createInvitedAccountService(deps.pool) : undefined),
        resolveActor,
        origin: process.env.APP_ORIGIN ?? 'http://localhost:3000',
        readBody: async () => {
          const length = req.headers['content-length'];
          if (typeof length === 'string' && Number(length) > MAX_BODY_BYTES)
            throw new HttpError(413, 413, 'PAYLOAD_TOO_LARGE', 'request body too large');
          const parsed = await readBody(req);
          return parsed?.body;
        },
      },
      requestId,
    );
    if (result.cookies?.length) res.setHeader('set-cookie', result.cookies);
    sendJson(res, result.status, result.body, requestId);
    return;
  }
  const protectedPost =
    req.method === 'POST' &&
    (pathname === '/api/v1/approvals' ||
      pathname.startsWith('/api/v1/approvals/') ||
      pathname.startsWith('/api/v1/document-approvals/') ||
      pathname.startsWith('/api/v1/conversations/') ||
      pathname === '/api/v1/tasks' ||
      pathname.startsWith('/api/v1/tasks/'));
  if (protectedPost) {
    const actor = await resolveActor(req);
    if (!actor) {
      closeUnreadRequest(req, res);
      sendJson(res, 401, failEnvelope(unauthorized(), requestId), requestId);
      return;
    }
    // Resolve once; module entry points retain their own authorization guards.
    resolveActor = async () => actor;
    const writeRoute =
      pathname === '/api/v1/conversations/messages' ||
      /^\/api\/v1\/conversations\/[^/]+\/runs\/[^/]+\/actions\/(?:cancel|resume)$/.test(pathname) ||
      /^\/api\/v1\/approvals\/[^/]+\/actions\/(?:confirm|reject|revise)$/.test(pathname) ||
      /^\/api\/v1\/document-approvals\/[^/]+\/actions\/(?:confirm|reject)$/.test(pathname) ||
      /^\/api\/v1\/tasks\/[^/]+\/actions\/cancel$/.test(pathname);
    if (!writeRoute) {
      closeUnreadRequest(req, res);
      sendJson(res, 404, failEnvelope(notFound(), requestId), requestId);
      return;
    }
    if (!verifyCsrf(req, actor)) {
      closeUnreadRequest(req, res);
      sendJson(res, 403, failEnvelope(csrfMismatch(), requestId), requestId);
      return;
    }
    try {
      // Content-Length is only an early rejection hint. Chunked requests and
      // all accepted lengths still pass through the cumulative byte counter.
      const length = req.headers['content-length'];
      if (typeof length === 'string' && Number(length) > MAX_BODY_BYTES) {
        throw new HttpError(413, 413, 'PAYLOAD_TOO_LARGE', 'request body too large');
      }
      const parsed = await readBody(req);
      if (!parsed) return;
      body = parsed.body;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      closeUnreadRequest(req, res);
      sendJson(res, err.httpStatus, failEnvelope(err, requestId), requestId);
      return;
    }
  }

  if (req.method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' }, requestId);
    return;
  }

  if (req.method === 'GET' && pathname === '/readyz') {
    if (!timeContext.available) {
      sendJson(
        res,
        503,
        {
          status: 'not_ready',
          reason: 'TZDB_UNAVAILABLE',
          ...(timeContext.missing.length ? { details: { missing: timeContext.missing } } : {}),
        },
        requestId,
      );
      return;
    }
    try {
      if (!deps.pool) throw new Error('database unavailable');
      await deps.pool.query('SELECT 1');
    } catch {
      sendJson(res, 503, { status: 'not_ready', reason: 'NOT_READY' }, requestId);
      return;
    }
    sendJson(res, 200, { status: 'ok' }, requestId);
    return;
  }

  // GET /me: session self-check. Returns the actor snapshot + CSRF token +
  // confirmed timezone with no-store; 401 envelope (code:401) without one.
  if (req.method === 'GET' && pathname === '/api/v1/me') {
    const actor = await resolveActor(req);
    if (!actor) {
      sendJson(res, 401, failEnvelope(unauthorized(), requestId), requestId);
      return;
    }
    sendJson(
      res,
      200,
      okEnvelope(
        {
          user: { id: actor.ownerId, display_name: actor.displayName },
          csrf_token: csrfTokenFor(actor),
          confirmed_timezone: actor.timezoneId,
        },
        requestId,
      ),
      requestId,
      { 'cache-control': 'no-store' },
    );
    return;
  }

  if (pathname === '/api/v1/workspaces') {
    if (await handleWorkspaceRoute(req, res, url, { resolveActor })) return;
  }

  if (pathname.startsWith('/api/v1/document-approvals/')) {
    if (
      await handleDocumentApprovalRoute(req, res, url, {
        pool: deps.pool,
        resolveActor,
        body,
      })
    )
      return;
    closeUnreadRequest(req, res);
    sendJson(res, 404, failEnvelope(notFound(), requestId), requestId);
    return;
  }

  if (pathname === '/api/v1/brief') {
    const handled = await handleBriefRoute(req, res, url, {
      pool: deps.pool,
      resolveActor,
      tzdbVersion,
      timeContext,
    });
    if (handled) return;
  }

  // Approvals read routes (PR1) + confirm/reject (PR2).
  if (pathname === '/api/v1/approvals' || pathname.startsWith('/api/v1/approvals/')) {
    if (req.method === 'GET' || req.method === 'POST') {
      const handled = await handleApprovalRoute(req, res, url, {
        pool: deps.pool,
        resolveActor,
        body,
        timeContext,
      });
      if (handled) return;
    } else {
      const actor = await resolveActor(req);
      if (!actor) {
        sendJson(res, 401, failEnvelope(unauthorized(), requestId), requestId);
        return;
      }
    }
    sendJson(res, 404, failEnvelope(notFound('not found'), requestId), requestId);
    return;
  }

  if (pathname === '/api/v1/conversations' || pathname.startsWith('/api/v1/conversations/')) {
    if (req.method === 'GET' || req.method === 'POST') {
      const handled = await handleConversationRoute(req, res, url, {
        pool: deps.pool,
        resolveActor,
        body,
        timeContext,
        harness: deps.harness,
        routing: deps.routing,
      });
      if (handled) return;
    }
    sendJson(res, 404, failEnvelope(notFound('not found'), requestId), requestId);
    return;
  }

  if (pathname === '/api/v1/tasks' || pathname.startsWith('/api/v1/tasks/')) {
    if (req.method === 'GET' || req.method === 'POST') {
      const handled = await handleTaskRoute(req, res, url, {
        pool: deps.pool,
        resolveActor,
        body,
      });
      if (handled) return;
    }
    sendJson(res, 404, failEnvelope(notFound('not found'), requestId), requestId);
    return;
  }

  closeUnreadRequest(req, res);

  sendJson(
    res,
    404,
    {
      code: 404,
      data: null,
      msg: 'not found',
      error: { code: 'NOT_FOUND', message: 'not found', request_id: requestId },
      request_id: requestId,
    },
    requestId,
  );
}

/** Catch dependency errors at the outer boundary, including pre-body gates. */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: TzdbOnlyOpts | AppDeps,
): Promise<void> {
  try {
    await dispatchRequest(req, res, opts);
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    const failure = error instanceof HttpError ? error : notReady();
    closeUnreadRequest(req, res);
    const requestId = requestIdOf(req);
    const details = failure.details;
    const retryAfter =
      failure.httpStatus === 429 &&
      details !== null &&
      typeof details === 'object' &&
      'retry_after_seconds' in details &&
      typeof details.retry_after_seconds === 'number' &&
      Number.isFinite(details.retry_after_seconds) &&
      details.retry_after_seconds > 0
        ? String(Math.ceil(details.retry_after_seconds))
        : null;
    sendJson(
      res,
      failure.httpStatus,
      failEnvelope(failure, requestId),
      requestId,
      retryAfter ? { 'retry-after': retryAfter } : undefined,
    );
  }
}
