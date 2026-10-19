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
import { requestCancel } from './cancel.js';
import { getTaskDetail, getTaskEvents, listTasksForOwner } from './service.js';

export interface RouteDeps {
  pool: Pool | null;
  resolveActor: ActorResolver;
  // POST body, parsed by the app layer (node:http has no body parser).
  body?: unknown;
}

function queryOf(url: URL): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  url.searchParams.forEach((_value, key) => {
    if (out[key] === undefined) {
      const all = url.searchParams.getAll(key);
      out[key] = all.length > 1 ? all : all[0];
    }
  });
  return out;
}

// Returns true when handled (including auth failures).
export async function handleTaskRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: RouteDeps,
): Promise<boolean> {
  const { pathname } = url;
  if (pathname !== '/api/v1/tasks' && !pathname.startsWith('/api/v1/tasks/')) {
    return false;
  }

  const requestId = requestIdOf(req);
  const actor = await deps.resolveActor(req);
  if (!actor) {
    sendJson(res, 401, failEnvelope(unauthorized(), requestId), requestId);
    return true;
  }

  try {
    if (req.method === 'GET' && pathname === '/api/v1/tasks') {
      const result = await listTasksForOwner(deps, actor.ownerId, queryOf(url));
      sendJson(res, 200, okEnvelope(result, requestId), requestId);
      return true;
    }

    const eventsMatch = /^\/api\/v1\/tasks\/([^/]+)\/events$/.exec(pathname);
    if (req.method === 'GET' && eventsMatch) {
      const taskId = eventsMatch[1] ?? '';
      if (!isUuid(taskId)) throw notFound('task not found');
      const result = await getTaskEvents(deps, actor.ownerId, taskId, queryOf(url));
      sendJson(res, 200, okEnvelope(result, requestId), requestId);
      return true;
    }

    const cancelMatch = /^\/api\/v1\/tasks\/([^/]+)\/actions\/cancel$/.exec(pathname);
    if (req.method === 'POST' && cancelMatch) {
      if (!verifyCsrf(req, actor)) {
        sendJson(res, 403, failEnvelope(csrfMismatch(), requestId), requestId);
        return true;
      }
      const taskId = cancelMatch[1] ?? '';
      if (!isUuid(taskId)) {
        throw notFound('task not found');
      }
      const result = await requestCancel({ pool: deps.pool }, actor.ownerId, taskId, deps.body);
      sendJson(res, 200, okEnvelope(result, requestId), requestId);
      return true;
    }

    const detailMatch = /^\/api\/v1\/tasks\/([^/]+)$/.exec(pathname);
    if (req.method === 'GET' && detailMatch) {
      const taskId = detailMatch[1] ?? '';
      if (!isUuid(taskId)) throw notFound('task not found');
      const detail = await getTaskDetail(deps, actor.ownerId, taskId);
      sendJson(res, 200, okEnvelope(detail, requestId), requestId);
      return true;
    }
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.httpStatus, failEnvelope(err, requestId), requestId);
      return true;
    }
    // Non-HttpError (e.g. pg DatabaseError): sanitized 500, no DB internals.
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
