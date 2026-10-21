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
import { executeRun, getConversationDetail, startConversationRun } from './service.js';
import type { TimeContext } from '../time/context.js';

export interface RouteDeps {
  pool: Pool | null;
  resolveActor: ActorResolver;
  body?: unknown;
  timeContext: TimeContext;
}

function queryOf(url: URL): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  url.searchParams.forEach((value, key) => {
    out[key] = value;
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

export async function handleConversationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: RouteDeps,
): Promise<boolean> {
  const { pathname } = url;
  if (
    pathname !== '/api/v1/conversations/messages' &&
    !pathname.startsWith('/api/v1/conversations/')
  ) {
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
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-request-id': requestId,
      });
      res.flushHeaders?.();
      if (started.replay) {
        for (const event of started.replay) {
          if (!writeEvent(res, event)) break;
        }
        res.end();
        return true;
      }
      if (!started.context) throw new Error('run context missing');
      try {
        await executeRun(deps, started.context, async (event) => writeEvent(res, event));
      } catch {
        // executeRun already attempted thread.failed; just close the stream.
      }
      res.end();
      return true;
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
