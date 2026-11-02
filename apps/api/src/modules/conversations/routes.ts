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
} from './service.js';
import type { StartResult } from './contracts.js';
import type { HarnessServices } from './harness-process.js';
import type { TimeContext } from '../time/context.js';
import type { RoutingRuntime } from './routing/index.js';
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
  harness?: HarnessServices | null;
  routing?: RoutingRuntime;
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

async function streamRun(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RouteDeps,
  started: StartResult,
  requestId: string,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-request-id': requestId,
  });
  res.flushHeaders?.();
  if (started.replay) {
    for (const event of started.replay) if (!writeEvent(res, event)) break;
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
      await streamRun(req, res, deps, started, requestId);
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

    const runMatch =
      /^\/api\/v1\/conversations\/([^/]+)\/runs\/([^/]+)(?:\/actions\/(cancel|resume))?$/.exec(
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
        if (runMatch[3] === 'cancel') {
          const view = await cancelConversationRun(
            deps,
            actor.ownerId,
            conversationId,
            runId,
            requestId,
            deps.body,
          );
          sendJson(res, 200, okEnvelope(view, requestId), requestId);
        } else {
          const started = await resumeConversationRun(
            deps,
            actor.ownerId,
            conversationId,
            runId,
            requestId,
            deps.body,
          );
          await streamRun(req, res, deps, started, requestId);
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
