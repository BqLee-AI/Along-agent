import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authInitializeSchema,
  authClaimSchema,
  authSignInSchema,
  authSignOutSchema,
} from '@along/contracts';
import type { AccountService } from './account-service.js';
import {
  csrfMismatch,
  HttpError,
  notFound,
  okEnvelope,
  validationError,
} from '../../http/errors.js';
import { verifyCsrf, type ActorResolver } from '../../http/auth.js';

export interface AccountRouteDeps {
  service: AccountService;
  resolveActor: ActorResolver;
  readBody: () => Promise<unknown>;
  origin: string;
}
/** Exact routes only. The Better Auth handler is deliberately never exposed. */
export async function handleAccountRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: AccountRouteDeps,
  requestId: string,
): Promise<{ status: number; body: unknown; cookies?: string[] }> {
  if (req.method === 'GET' && pathname === '/api/v1/auth/status') {
    return {
      status: 200,
      body: okEnvelope(await deps.service.status(await deps.resolveActor(req)), requestId),
    };
  }
  const routes: Record<string, true> = {
    '/api/v1/auth/initialize': true,
    '/api/v1/auth/claim': true,
    '/api/v1/auth/sign-in': true,
    '/api/v1/auth/sign-out': true,
  };
  if (req.method !== 'POST' || !routes[pathname]) throw notFound();
  if (req.headers.origin !== deps.origin)
    throw new HttpError(403, 403, 'FORBIDDEN', 'origin mismatch', { reason: 'ORIGIN_MISMATCH' });
  const sessionBound = pathname === '/api/v1/auth/claim' || pathname === '/api/v1/auth/sign-out';
  const actor = sessionBound ? await deps.resolveActor(req) : null;
  if (sessionBound) {
    if (!actor) throw new HttpError(401, 401, 'UNAUTHENTICATED', 'unauthorized');
    if (!actor.sessionId)
      throw new HttpError(403, 403, 'FORBIDDEN', 'signed session required', {
        reason: 'SIGNED_SESSION_REQUIRED',
      });
    if (!verifyCsrf(req, actor)) throw csrfMismatch();
  }
  const body = await deps.readBody();
  if (pathname === '/api/v1/auth/initialize') {
    const parsed = authInitializeSchema.safeParse(body);
    if (!parsed.success) throw validationError('invalid account fields');
    const result = await deps.service.initialize(parsed.data);
    return {
      status: 201,
      cookies: result.cookies,
      body: okEnvelope(
        { authenticated: true, workspace_binding: 'pending_local_configuration' },
        requestId,
      ),
    };
  }
  if (pathname === '/api/v1/auth/claim') {
    const parsed = authClaimSchema.safeParse(body);
    if (!parsed.success) throw validationError('invalid account fields');
    const result = await deps.service.claim(actor!.ownerId, parsed.data);
    return {
      status: 200,
      cookies: result.cookies,
      body: okEnvelope(
        { authenticated: true, workspace_binding: 'pending_local_configuration' },
        requestId,
      ),
    };
  }
  if (pathname === '/api/v1/auth/sign-in') {
    const parsed = authSignInSchema.safeParse(body);
    if (!parsed.success) throw validationError('invalid account fields');
    const result = await deps.service.signIn(parsed.data);
    return {
      status: 200,
      cookies: result.cookies,
      body: okEnvelope({ authenticated: true }, requestId),
    };
  }
  const parsed = authSignOutSchema.safeParse(body);
  if (!parsed.success) throw validationError('invalid account fields');
  const headers = new Headers();
  if (req.headers.cookie) headers.set('cookie', req.headers.cookie);
  if (req.headers.origin) headers.set('origin', req.headers.origin);
  const result = await deps.service.signOut(actor!.sessionId!, actor!.ownerId, headers);
  return {
    status: 200,
    cookies: result.cookies,
    body: okEnvelope({ signed_out: true }, requestId),
  };
}
