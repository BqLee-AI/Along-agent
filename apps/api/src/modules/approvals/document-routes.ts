import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { verifyCsrf, type ActorResolver } from '../../http/auth.js';
import {
  csrfMismatch,
  failEnvelope,
  forbidden,
  HttpError,
  isUuid,
  notFound,
  notReady,
  okEnvelope,
  requestIdOf,
  sendJson,
  unauthorized,
} from '../../http/errors.js';
import { confirmDocumentApproval, rejectDocumentApproval } from './document-actions.js';
import { readDocumentApprovalDetail } from './document-service.js';
import { WorkspaceDeniedError } from '../workspaces/service.js';

export interface DocumentApprovalRouteDeps {
  pool: Pool | null;
  resolveActor: ActorResolver;
  body?: unknown;
}
export async function handleDocumentApprovalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: DocumentApprovalRouteDeps,
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/v1/document-approvals/')) return false;
  const requestId = requestIdOf(req);
  const actor = await deps.resolveActor(req);
  if (!actor) {
    sendJson(res, 401, failEnvelope(unauthorized(), requestId), requestId);
    return true;
  }
  try {
    const match = /^\/api\/v1\/document-approvals\/([^/]+)(?:\/actions\/(confirm|reject))?$/.exec(
      url.pathname,
    );
    if (!match) return false;
    const id = match[1] ?? '';
    if (!isUuid(id)) throw notFound('document approval not found');
    const action = match[2];
    if (req.method === 'GET' && !action) {
      if (!deps.pool) throw notReady();
      const client = await deps.pool.connect();
      try {
        const detail = await readDocumentApprovalDetail(client, actor.ownerId, id);
        sendJson(res, 200, okEnvelope(detail, requestId), requestId, {
          'cache-control': 'no-store',
        });
      } finally {
        client.release();
      }
      return true;
    }
    if (req.method === 'POST' && action) {
      if (!verifyCsrf(req, actor)) throw csrfMismatch();
      const result =
        action === 'confirm'
          ? await confirmDocumentApproval(deps, actor.ownerId, id, deps.body)
          : await rejectDocumentApproval(deps, actor.ownerId, id, deps.body);
      sendJson(res, 200, okEnvelope(result, requestId), requestId, { 'cache-control': 'no-store' });
      return true;
    }
    return false;
  } catch (error) {
    const failure =
      error instanceof HttpError
        ? error
        : error instanceof WorkspaceDeniedError
          ? forbidden()
          : new HttpError(500, 500, 'INTERNAL_ERROR', 'internal error');
    sendJson(res, failure.httpStatus, failEnvelope(failure, requestId), requestId, {
      'cache-control': 'no-store',
    });
    return true;
  }
}
