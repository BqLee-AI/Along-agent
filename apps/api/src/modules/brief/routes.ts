// GET /api/v1/brief (issue #10). Read-only, owner-scoped, no CSRF.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import type { ActorResolver } from '../../http/auth.js';
import {
  failEnvelope,
  HttpError,
  okEnvelope,
  requestIdOf,
  sendJson,
  unauthorized,
} from '../../http/errors.js';
import { getBrief } from './service.js';

export interface BriefRouteDeps {
  pool: Pool | null;
  resolveActor: ActorResolver;
  tzdbVersion?: string;
}

// Returns true when handled (including auth failures).
export async function handleBriefRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: BriefRouteDeps,
): Promise<boolean> {
  if (url.pathname !== '/api/v1/brief' || req.method !== 'GET') return false;
  const requestId = requestIdOf(req);
  const actor = await deps.resolveActor(req);
  if (!actor) {
    sendJson(res, 401, failEnvelope(unauthorized(), requestId), requestId);
    return true;
  }
  try {
    const query: Record<string, string | string[] | undefined> = {};
    url.searchParams.forEach((_value, key) => {
      if (query[key] === undefined) {
        const all = url.searchParams.getAll(key);
        query[key] = all.length > 1 ? all : all[0];
      }
    });
    const brief = await getBrief(
      { pool: deps.pool, tzdbVersion: deps.tzdbVersion },
      actor.ownerId,
      actor.timezoneId,
      query,
      requestId,
    );
    sendJson(res, 200, okEnvelope(brief, requestId), requestId, {
      'cache-control': 'no-store',
    });
    return true;
  } catch (err) {
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
}
