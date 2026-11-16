// Conversations routes (issue #9): POST /conversations/messages (SSE) and
// GET /conversations/{id} (history replay). Connect-time failures use the
// JSON envelope; once the stream is open every failure is a thread.failed
// event (docs/api/conversations §4).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import {
  csrfMismatch,
  failEnvelope,
  HttpError,
  isUuid,
  notFound,
  okEnvelope,
  requestIdOf,
  sendJson,
  unauthorized,
} from '../../http/errors.js';
import { verifyCsrf, type ActorResolver } from '../../http/auth.js';
import type { ThreadEvent } from '@along/stream-protocol';
import {
  executeRun,
  getConversationDetail,
  startConversationRun,
  getRunView,
  cancelConversationRun,
  resumeConversationRun,
  requestRuntimeCompactPause,
  getCompactReceipt,
  startIdleCompact,
} from './service.js';
import { requestConversationPause, continueConversationPause } from './harness-authority.js';
import type { ConversationDeps, StartResult } from './contracts.js';
import type { TimeContext } from '../time/context.js';
import type { RoutingRuntime } from './routing/index.js';
import { writeAuthorizedEvent } from './stream-authorization.js';
import { withTransaction } from '../../db/transaction.js';
import { lockViewerAccess } from '../identity/stream-access.js';
import { ActionKeySchema, CompactRunBodySchema, ConversationEventsQuerySchema } from './schemas.js';
import { validationError } from '../../http/errors.js';
import type { Actor } from '../../http/auth.js';
import type { RunDriver } from './run-driver.js';
import {
  getConversationList,
  getConversationMessages,
  getConversationRuns,
} from './history-service.js';

export interface RouteDeps {
  pool: Pool | null;
  resolveActor: ActorResolver;
  body?: unknown;
  timeContext: TimeContext;
  harness?: ConversationDeps['harness'];
  modelTransport?: ConversationDeps['modelTransport'];
  routing?: RoutingRuntime;
  runDriver?: RunDriver;
}

function queryOf(url: URL): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = Object.create(null);
  url.searchParams.forEach((value, key) => {
    const previous = out[key];
    out[key] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  });
  return out;
}

function idempotencyKeyOf(req: IncomingMessage): string | null {
  const raw = req.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.trim() !== '' ? value.trim() : null;
}

function writeEvent(res: ServerResponse, event: ThreadEvent): boolean {
  if (res.destroyed || res.writableEnded) return false;
  res.write(`data: ${JSON.stringify(event)}\n\n`);
  return true;
}
// Subscribers consume only persisted events. They never own the execution
// controller, and a slow socket cannot hold an authorization transaction.
async function subscribeRun(
  res: ServerResponse,
  deps: RouteDeps,
  actor: Actor,
  conversationId: string,
  runId: string,
  requestId: string,
  afterSeq: number | null,
): Promise<void> {
  if (!deps.pool) throw new Error('database unavailable');
  const pool = deps.pool;
  await getRunView(deps, actor.ownerId, conversationId, runId);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-request-id': requestId,
    'x-conversation-id': conversationId,
    'x-run-id': runId,
  });
  res.flushHeaders?.();
  let closed = false;
  const onClose = () => {
    closed = true;
  };
  res.once('close', onClose);
  let finalDrain = false;
  try {
    while (!closed && !res.destroyed && !res.writableEnded) {
      const detail = await getConversationDetail(deps, actor.ownerId, conversationId, {
        run_id: runId,
        limit: '200',
        ...(afterSeq === null ? {} : { after_seq: String(afterSeq) }),
      });
      for (const event of detail.events) {
        let writable = true;
        const delivered = await writeAuthorizedEvent(
          pool,
          actor.ownerId,
          async (item) => {
            if (closed || res.destroyed || res.writableEnded) return false;
            writable = res.write(`data: ${JSON.stringify(item)}\n\n`);
            return true;
          },
          event,
          actor.sessionId,
        );
        if (!delivered) return;
        afterSeq = event.seq;
        if (!writable) {
          const { promise, resolve } = Promise.withResolvers<void>();
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.once('drain', done);
          res.once('close', done);
          if (closed || res.destroyed) done();
          await promise;
          if (closed) return;
        }
      }
      if (detail.events.length === 200) continue;
      if (finalDrain) return;
      const view = await getRunView(deps, actor.ownerId, conversationId, runId);
      if (view.status !== 'running') {
        finalDrain = true;
        continue;
      }
      await withTransaction(pool, async (client) => {
        if (!(await lockViewerAccess(client, actor.ownerId, actor.sessionId))) throw unauthorized();
      });
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(done, 500);
      function done() {
        clearTimeout(timer);
        res.off('close', done);
        resolve();
      }
      res.once('close', done);
      if (closed || res.destroyed) done();
      await promise;
    }
  } finally {
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

async function streamRun(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouteDeps,
  started: StartResult,
  actor: Actor,
  requestId: string,
): Promise<void> {
  if ('serverOwned' in started && started.serverOwned === true) {
    const afterSeq =
      'afterSeq' in started && typeof started.afterSeq === 'number' ? started.afterSeq : null;
    await subscribeRun(
      res,
      deps,
      actor,
      started.conversationId,
      started.runId,
      requestId,
      afterSeq,
    );
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-request-id': requestId,
    'x-conversation-id': started.conversationId,
    'x-run-id': started.runId,
  });
  res.flushHeaders?.();
  if (started.replay) {
    if (!deps.pool) throw new Error('database unavailable');
    for (const event of started.replay)
      if (
        !(await writeAuthorizedEvent(
          deps.pool,
          actor.ownerId,
          async (item) => writeEvent(res, item),
          event,
        ))
      )
        break;
    res.end();
    return;
  }
  if (!started.context) throw new Error('run context missing');
  const controller = new AbortController();
  const closed = () => controller.abort();
  res.once('close', closed);
  try {
    await executeRun(
      deps,
      started.context,
      async (event) => writeEvent(res, event),
      controller.signal,
    );
  } finally {
    // A suspended attempt ends its stream normally; this is not cancellation.
    res.off('close', closed);
    if (!res.writableEnded) res.end();
  }
}

export async function handleConversationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: RouteDeps,
): Promise<boolean> {
  const { pathname } = url;
  if (pathname !== '/api/v1/conversations' && !pathname.startsWith('/api/v1/conversations/')) {
    return false;
  }

  const requestId = requestIdOf(req);
  const actor = await deps.resolveActor(req);
  if (!actor) {
    sendJson(res, 401, failEnvelope(unauthorized(), requestId), requestId);
    return true;
  }

  try {
    if (req.method === 'POST' && pathname === '/api/v1/conversations/messages') {
      if (!verifyCsrf(req, actor)) {
        sendJson(res, 403, failEnvelope(csrfMismatch(), requestId), requestId);
        return true;
      }
      const started = await startConversationRun(
        deps,
        actor.ownerId,
        requestId,
        deps.body,
        idempotencyKeyOf(req),
      );
      await streamRun(req, res, deps, started, actor, requestId);
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/v1/conversations') {
      const page = await getConversationList(deps, actor.ownerId, queryOf(url));
      sendJson(res, 200, okEnvelope(page, requestId), requestId);
      return true;
    }
    const collectionMatch = /^\/api\/v1\/conversations\/([^/]+)\/(messages|runs)$/.exec(pathname);
    if (req.method === 'GET' && collectionMatch) {
      const conversationId = collectionMatch[1] ?? '';
      if (!isUuid(conversationId)) throw notFound('conversation not found');
      const page =
        collectionMatch[2] === 'messages'
          ? await getConversationMessages(deps, actor.ownerId, conversationId, queryOf(url))
          : await getConversationRuns(deps, actor.ownerId, conversationId, queryOf(url));
      sendJson(res, 200, okEnvelope(page, requestId), requestId);
      return true;
    }

    const eventsMatch = /^\/api\/v1\/conversations\/([^/]+)\/runs\/([^/]+)\/events$/.exec(pathname);
    if (req.method === 'GET' && eventsMatch) {
      const conversationId = eventsMatch[1] ?? '';
      const runId = eventsMatch[2] ?? '';
      if (!isUuid(conversationId) || !isUuid(runId)) throw notFound('Run not found');
      const parsed = ConversationEventsQuerySchema.safeParse(queryOf(url));
      if (!parsed.success || parsed.data.run_id !== undefined || url.searchParams.has('limit'))
        throw validationError('invalid events query');
      await subscribeRun(
        res,
        deps,
        actor,
        conversationId,
        runId,
        requestId,
        parsed.data.after_seq ?? null,
      );
      return true;
    }

    const compactMatch =
      /^\/api\/v1\/conversations\/([^/]+)\/runs\/([^/]+)\/compacts\/([^/]+)$/.exec(pathname);
    if (req.method === 'GET' && compactMatch) {
      const [, conversationId, runId, pauseId] = compactMatch;
      if (!isUuid(conversationId!) || !isUuid(runId!) || !isUuid(pauseId!))
        throw notFound('compact operation not found');
      const receipt = await getCompactReceipt(
        deps,
        actor.ownerId,
        conversationId!,
        runId!,
        pauseId!,
      );
      sendJson(res, 200, okEnvelope(receipt, requestId), requestId);
      return true;
    }

    const idleCompactMatch = /^\/api\/v1\/conversations\/([^/]+)\/actions\/compact$/.exec(pathname);
    if (req.method === 'POST' && idleCompactMatch) {
      if (!verifyCsrf(req, actor)) throw csrfMismatch();
      const conversationId = idleCompactMatch[1] ?? '';
      if (!isUuid(conversationId)) throw notFound('conversation not found');
      const key = idempotencyKeyOf(req);
      if (
        !ActionKeySchema.safeParse(key).success ||
        !CompactRunBodySchema.safeParse(deps.body).success
      )
        throw validationError('invalid compact request');
      const result = await startIdleCompact(deps, actor.ownerId, conversationId, requestId, key!);
      const receipt =
        result.status === 'no_content'
          ? { status: 'no_content', run_id: null, pause_id: null }
          : await getCompactReceipt(
              deps,
              actor.ownerId,
              conversationId,
              result.runId,
              result.pauseId,
            );
      sendJson(res, 200, okEnvelope(receipt, requestId), requestId);
      return true;
    }

    const runMatch =
      /^\/api\/v1\/conversations\/([^/]+)\/runs\/([^/]+)(?:\/actions\/(cancel|resume|pause|continue|compact))?$/.exec(
        pathname,
      );
    if (runMatch) {
      const conversationId = runMatch[1] ?? '';
      const runId = runMatch[2] ?? '';
      if (!isUuid(conversationId) || !isUuid(runId)) throw notFound('Run not found');
      if (req.method === 'GET' && !runMatch[3]) {
        const view = await getRunView(deps, actor.ownerId, conversationId, runId);
        sendJson(res, 200, okEnvelope(view, requestId), requestId);
        return true;
      }
      if (req.method === 'POST' && runMatch[3]) {
        if (!verifyCsrf(req, actor)) throw csrfMismatch();
        if (runMatch[3] === 'compact') {
          const key = idempotencyKeyOf(req);
          if (
            !ActionKeySchema.safeParse(key).success ||
            !CompactRunBodySchema.safeParse(deps.body).success
          )
            throw validationError('invalid compact request');
          const pending = await requestRuntimeCompactPause(
            deps,
            actor.ownerId,
            conversationId,
            runId,
            'manual_compact',
            key!,
          );
          const receipt = await getCompactReceipt(
            deps,
            actor.ownerId,
            conversationId,
            runId,
            pending.pause_id,
          );
          sendJson(res, 200, okEnvelope(receipt, requestId), requestId);
        } else if (runMatch[3] === 'cancel') {
          const view = await cancelConversationRun(
            deps,
            actor.ownerId,
            conversationId,
            runId,
            requestId,
            deps.body,
          );
          sendJson(res, 200, okEnvelope(view, requestId), requestId);
        } else if (runMatch[3] === 'pause') {
          const pause = await requestConversationPause(
            deps,
            actor.ownerId,
            conversationId,
            runId,
            deps.body,
            idempotencyKeyOf(req),
          );
          sendJson(res, 200, okEnvelope(pause, requestId), requestId);
        } else if (runMatch[3] === 'continue') {
          const started = await continueConversationPause(
            deps,
            actor.ownerId,
            conversationId,
            runId,
            requestId,
            deps.body,
            idempotencyKeyOf(req),
          );
          await streamRun(req, res, deps, started, actor, requestId);
        } else {
          const started = await resumeConversationRun(
            deps,
            actor.ownerId,
            conversationId,
            runId,
            requestId,
            deps.body,
          );
          await streamRun(req, res, deps, started, actor, requestId);
        }
        return true;
      }
    }

    const detailMatch = /^\/api\/v1\/conversations\/([^/]+)$/.exec(pathname);
    if (req.method === 'GET' && detailMatch) {
      const conversationId = detailMatch[1] ?? '';
      if (!isUuid(conversationId)) throw notFound('conversation not found');
      const detail = await getConversationDetail(deps, actor.ownerId, conversationId, queryOf(url));
      sendJson(res, 200, okEnvelope(detail, requestId), requestId);
      return true;
    }
  } catch (err) {
    // Headers are already on the wire: JSON would corrupt the SSE body.
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return true;
    }
    if (err instanceof HttpError) {
      sendJson(res, err.httpStatus, failEnvelope(err, requestId), requestId);
      return true;
    }
    sendJson(
      res,
      500,
      {
        code: 500,
        data: null,
        msg: 'internal error',
        error: { code: 'INTERNAL_ERROR', message: 'internal error', request_id: requestId },
        request_id: requestId,
      },
      requestId,
    );
    return true;
  }

  return false;
}
