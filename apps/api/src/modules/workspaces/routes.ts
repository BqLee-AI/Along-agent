import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActorResolver } from '../../http/auth.js';
import {
  failEnvelope,
  okEnvelope,
  requestIdOf,
  sendJson,
  unauthorized,
  notFound,
} from '../../http/errors.js';
import { listWorkspaces } from './service.js';

export async function handleWorkspaceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: { resolveActor: ActorResolver },
): Promise<boolean> {
  if (url.pathname !== '/api/v1/workspaces') return false;
  const requestId = requestIdOf(req);
  res.setHeader('Cache-Control', 'no-store');
  const actor = await deps.resolveActor(req);
  if (!actor) {
    sendJson(res, 401, failEnvelope(unauthorized(), requestId), requestId);
    return true;
  }
  if (req.method !== 'GET') {
    sendJson(res, 404, failEnvelope(notFound('route not found'), requestId), requestId);
    return true;
  }
  sendJson(res, 200, okEnvelope({ items: listWorkspaces(actor.ownerId) }, requestId), requestId);
  return true;
}
