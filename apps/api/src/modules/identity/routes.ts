import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import {
  authInitializeSchema,
  authClaimSchema,
  authSignInSchema,
  authSignOutSchema,
  authContactRequestSchema,
  authInvitationCreateSchema,
  authInvitationResendSchema,
  authInvitationRevokeSchema,
  authPasswordForgotSchema,
  authPasswordChangeSchema,
  authSessionRevokeSchema,
  authSessionsRevokeSchema,
  authDisableUserSchema,
  authDeletionRequestSchema,
  authListQuerySchema,
} from '@along/contracts';
import type { AccountService } from './account-service.js';
import type { InvitedAccountService } from './invited-service.js';
import {
  csrfMismatch,
  HttpError,
  isUuid,
  notFound,
  notReady,
  okEnvelope,
  unauthorized,
  validationError,
} from '../../http/errors.js';
import { verifyCsrf, type ActorResolver } from '../../http/auth.js';

export interface AccountRouteDeps {
  service: AccountService;
  invitedService?: InvitedAccountService;
  resolveActor: ActorResolver;
  readBody: () => Promise<unknown>;
  origin: string;
}

const getPaths: Record<string, true> = {
  '/api/v1/auth/status': true,
  '/api/v1/auth/account': true,
  '/api/v1/auth/invitations': true,
  '/api/v1/auth/sessions': true,
  '/api/v1/auth/users': true,
};
const postPaths: Record<string, true> = {
  '/api/v1/auth/initialize': true,
  '/api/v1/auth/claim': true,
  '/api/v1/auth/sign-in': true,
  '/api/v1/auth/sign-out': true,
  '/api/v1/auth/contact/request': true,
  '/api/v1/auth/contact/verify': true,
  '/api/v1/auth/invitations': true,
  '/api/v1/auth/invitations/accept': true,
  '/api/v1/auth/password/forgot': true,
  '/api/v1/auth/password/reset': true,
  '/api/v1/auth/password/change': true,
  '/api/v1/auth/sessions/revoke': true,
  '/api/v1/auth/deletion-request': true,
};
const targetPath =
  /^\/api\/v1\/auth\/(?:invitations\/([^/]+)\/(resend|revoke)|sessions\/([^/]+)\/revoke|users\/([^/]+)\/disable)$/;
const anonymousPosts: Record<string, true> = {
  '/api/v1/auth/initialize': true,
  '/api/v1/auth/sign-in': true,
  '/api/v1/auth/invitations/accept': true,
  '/api/v1/auth/password/forgot': true,
  '/api/v1/auth/password/reset': true,
};

/** Both the HTTP dispatcher and identity handler enforce this exact list. */
export function isKnownAccountRoute(method: string | undefined, pathname: string): boolean {
  return (
    (method === 'GET' && Object.hasOwn(getPaths, pathname)) ||
    (method === 'POST' && (Object.hasOwn(postPaths, pathname) || targetPath.test(pathname)))
  );
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError('invalid account fields');
  return result.data;
}

/** Exact routes only. The Better Auth handler is deliberately never exposed. */
export async function handleAccountRoute(
  req: IncomingMessage,
  _res: ServerResponse,
  pathname: string,
  deps: AccountRouteDeps,
  requestId: string,
): Promise<{ status: number; body: unknown; cookies?: string[] }> {
  if (!isKnownAccountRoute(req.method, pathname)) throw notFound();
  const result = (data: unknown, status = 200, cookies?: string[]) => ({
    status,
    body: okEnvelope(data, requestId),
    ...(cookies?.length ? { cookies } : {}),
  });
  if (req.method === 'GET' && pathname === '/api/v1/auth/status') {
    return result(
      await deps.service.status(await deps.resolveActor(req, { allowLegacyClaim: true })),
    );
  }
  if (req.method === 'POST' && req.headers.origin !== deps.origin)
    throw new HttpError(403, 403, 'FORBIDDEN', 'origin mismatch', { reason: 'ORIGIN_MISMATCH' });

  const signed = req.method === 'GET' || !Object.hasOwn(anonymousPosts, pathname);
  const actor = signed
    ? await deps.resolveActor(
        req,
        pathname === '/api/v1/auth/claim' ? { allowLegacyClaim: true } : undefined,
      )
    : null;
  if (signed) {
    if (!actor) throw unauthorized();
    if (!actor.sessionId)
      throw new HttpError(403, 403, 'FORBIDDEN', 'signed session required', {
        reason: 'SIGNED_SESSION_REQUIRED',
      });
    if (req.method === 'POST' && !verifyCsrf(req, actor)) throw csrfMismatch();
  }

  const invited = () => {
    if (!deps.invitedService) throw notReady('account service unavailable');
    return deps.invitedService;
  };
  if (req.method === 'GET') {
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
    if (new Set(params.keys()).size !== params.size) throw validationError('duplicate query field');
    if (pathname === '/api/v1/auth/account') {
      if (params.size) throw validationError('invalid account query');
      return result(await invited().account(actor!));
    }
    const query = parse(authListQuerySchema, Object.fromEntries(params));
    if (pathname === '/api/v1/auth/invitations')
      return result(await invited().listInvitations(actor!, query));
    if (pathname === '/api/v1/auth/sessions')
      return result(await invited().sessions(actor!, query));
    return result(await invited().users(actor!, query));
  }

  const target = targetPath.exec(pathname);
  const id = target?.[1] ?? target?.[3] ?? target?.[4];
  if (id && !isUuid(id)) throw validationError('invalid account resource id');
  // No forwarded client headers are trusted without a configured deployment
  // chain. Proxied clients share the peer bucket; they never bypass it.
  const ip = req.socket.remoteAddress ?? 'unknown-peer';
  const body = await deps.readBody();
  const headers = new Headers();
  if (req.headers.cookie) headers.set('cookie', req.headers.cookie);
  if (req.headers.origin) headers.set('origin', req.headers.origin);
  switch (pathname) {
    case '/api/v1/auth/initialize': {
      const session = await deps.service.initialize(parse(authInitializeSchema, body));
      return result(
        { authenticated: true, workspace_binding: 'pending_local_configuration' },
        201,
        session.cookies,
      );
    }
    case '/api/v1/auth/claim': {
      const session = await deps.service.claim(actor!.ownerId, parse(authClaimSchema, body));
      return result(
        { authenticated: true, workspace_binding: 'pending_local_configuration' },
        200,
        session.cookies,
      );
    }
    case '/api/v1/auth/sign-in': {
      const session = await deps.service.signIn(parse(authSignInSchema, body), ip);
      return result({ authenticated: true }, 200, session.cookies);
    }
    case '/api/v1/auth/sign-out': {
      parse(authSignOutSchema, body);
      const session = await deps.service.signOut(actor!.sessionId!, actor!.ownerId, headers);
      return result({ signed_out: true }, 200, session.cookies);
    }
    case '/api/v1/auth/contact/request':
      return result(
        await invited().requestContact(actor!, parse(authContactRequestSchema, body), ip),
        202,
      );
    case '/api/v1/auth/contact/verify':
      // Token endpoints consume durable quota even for invalid bounded input;
      // the service then applies the same strict shared DTO before lookup.
      return result(await invited().verifyContact(actor!, body, ip));
    case '/api/v1/auth/invitations': {
      const created = await invited().createInvitation(
        actor!,
        parse(authInvitationCreateSchema, body),
        ip,
      );
      return result({ invitation: created.invitation }, created.replayed ? 200 : 201);
    }
    case '/api/v1/auth/invitations/accept': {
      const input = body;
      const existingActor = await deps.resolveActor(req);
      return result(await invited().acceptInvitation(input, ip, existingActor), 201);
    }
    case '/api/v1/auth/password/forgot':
      return result(await invited().forgotPassword(parse(authPasswordForgotSchema, body), ip), 202);
    case '/api/v1/auth/password/reset':
      return result(await invited().resetPassword(body, ip));
    case '/api/v1/auth/password/change': {
      const changed = await invited().changePassword(
        actor!,
        parse(authPasswordChangeSchema, body),
        headers,
        ip,
      );
      return result({ password_changed: true, signed_out: true }, 200, changed.cookies);
    }
    case '/api/v1/auth/sessions/revoke': {
      const revoked = await invited().revokeSessions(
        actor!,
        parse(authSessionsRevokeSchema, body),
        headers,
        ip,
      );
      return result({ revoked: true, signed_out: revoked.signed_out }, 200, revoked.cookies);
    }
    case '/api/v1/auth/deletion-request': {
      const deleted = await invited().requestDeletion(
        actor!,
        parse(authDeletionRequestSchema, body),
        headers,
        ip,
      );
      return result({ deletion_requested: true, signed_out: true }, 200, deleted.cookies);
    }
  }
  if (target?.[1]) {
    if (target[2] === 'resend')
      return result(
        await invited().resendInvitation(actor!, id!, parse(authInvitationResendSchema, body), ip),
      );
    return result(
      await invited().revokeInvitation(actor!, id!, parse(authInvitationRevokeSchema, body), ip),
    );
  }
  if (target?.[3]) {
    parse(authSessionRevokeSchema, body);
    const revoked = await invited().revokeSession(actor!, id!, headers);
    return result({ revoked: true, signed_out: revoked.signed_out }, 200, revoked.cookies);
  }
  return result(await invited().disableUser(actor!, id!, parse(authDisableUserSchema, body), ip));
}
