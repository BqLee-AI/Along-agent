import { isModelProviderPath } from '../../features/model-providers/http/path.js';
import {
  ApplicationError,
  isUuid,
  notFound,
  notReady,
  unauthorized,
} from '../../platform/errors.js';
import type { HttpAccess } from '../access.js';

// Only Elysia NOT_FOUND reaches this compatibility policy; it never dispatches a route.
export async function unmatchedError(
  request: Request,
  hasPool: boolean,
  access: HttpAccess,
): Promise<ApplicationError> {
  const pathname = new URL(request.url).pathname;
  const inScope = (path: string) => pathname === path || pathname.startsWith(path + '/');
  const readOrWrite = request.method === 'GET' || request.method === 'POST';
  if (pathname.startsWith('/api/v1/auth/') || access.isAdmittedWrite(request)) return notFound();
  if (isModelProviderPath(pathname)) {
    if (!(await access.actor(request))) return unauthorized();
    if (!hasPool) return notReady();
    return notFound();
  }
  if (pathname === '/api/v1/workspaces')
    return (await access.actor(request)) ? notFound('route not found') : unauthorized();
  if (pathname.startsWith('/api/v1/document-approvals/')) {
    if (!(await access.actor(request))) return unauthorized();
    const match = /^\/api\/v1\/document-approvals\/([^/]+)(?:\/actions\/(?:confirm|reject))?$/.exec(
      pathname,
    );
    if (match && !isUuid(match[1]!)) return notFound('document approval not found');
  } else if (inScope('/api/v1/approvals')) {
    if (!(await access.actor(request))) return unauthorized();
  } else if (inScope('/api/v1/conversations')) {
    if (readOrWrite) {
      if (!(await access.actor(request))) return unauthorized();
      const match =
        /^\/api\/v1\/conversations\/([^/]+)\/runs\/([^/]+)(?:\/actions\/(?:cancel|resume|pause|continue|compact))?$/.exec(
          pathname,
        );
      if (match && (!isUuid(match[1]!) || !isUuid(match[2]!))) return notFound('Run not found');
    }
  } else if (inScope('/api/v1/memories')) {
    try {
      if (!(await access.actor(request))) return unauthorized();
      if (!hasPool) return notReady('memory unavailable');
      const match = /^\/api\/v1\/memories\/([^/]+)(?:\/actions\/(?:correct|stop-recall))?$/.exec(
        pathname,
      );
      if (match && !isUuid(match[1]!)) return notFound('memory not found');
    } catch (error) {
      if (error instanceof ApplicationError) return error;
      return new ApplicationError(500, 'INTERNAL_ERROR', 'internal error');
    }
  } else if (inScope('/api/v1/tasks') || inScope('/api/v1/bots')) {
    if (readOrWrite && !(await access.actor(request))) return unauthorized();
  }
  return notFound();
}
