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
import { confirmApproval, rejectApproval } from './confirm.js';
import { getApprovalDetail, listApprovalsForOwner } from './service.js';

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
export async function handleApprovalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: RouteDeps,
): Promise<boolean> {
  const { pathname } = url;
  if (pathname !== '/api/v1/approvals' && !pathname.startsWith('/api/v1/approvals/')) {
    return false;
  }

  const requestId = requestIdOf(req);
  const actor = await deps.resolveActor(req);
  if (!actor) {
    sendJson(res, 401, failEnvelope(unauthorized(), requestId), requestId);
    return true;
  }

  try {
    if (req.method === 'GET' && pathname === '/api/v1/approvals') {
      const result = await listApprovalsForOwner(deps, actor.ownerId, queryOf(url));
      sendJson(res, 200, okEnvelope(result, requestId), requestId);
      return true;
    }

    const detailMatch = /^\/api\/v1\/approvals\/([^/]+)$/.exec(pathname);
    if (req.method === 'GET' && detailMatch) {
      const approvalId = detailMatch[1] ?? '';
      if (!isUuid(approvalId)) {
        throw notFound('approval not found');
      }
      const { detail } = await getApprovalDetail(deps, actor.ownerId, approvalId);
      sendJson(res, 200, okEnvelope(detail, requestId), requestId);
      return true;
    }

    const confirmMatch = /^\/api\/v1\/approvals\/([^/]+)\/actions\/confirm$/.exec(pathname);
    if (req.method === 'POST' && confirmMatch) {
      if (!verifyCsrf(req, actor)) {
        sendJson(res, 403, failEnvelope(csrfMismatch(), requestId), requestId);
        return true;
      }
      const approvalId = confirmMatch[1] ?? '';
      if (!isUuid(approvalId)) {
        throw notFound('approval not found');
      }
      const result = await confirmApproval(deps, actor.ownerId, approvalId, deps.body);
      sendJson(res, 200, okEnvelope(result, requestId), requestId);
      return true;
    }

    const rejectMatch = /^\/api\/v1\/approvals\/([^/]+)\/actions\/reject$/.exec(pathname);
    if (req.method === 'POST' && rejectMatch) {
      if (!verifyCsrf(req, actor)) {
        sendJson(res, 403, failEnvelope(csrfMismatch(), requestId), requestId);
        return true;
      }
      const approvalId = rejectMatch[1] ?? '';
      if (!isUuid(approvalId)) {
        throw notFound('approval not found');
      }
      const result = await rejectApproval(deps, actor.ownerId, approvalId, deps.body);
      sendJson(res, 200, okEnvelope(result, requestId), requestId);
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

export { notFound };
