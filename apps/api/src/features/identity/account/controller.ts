import { Elysia } from 'elysia';
import * as model from './model.js';
import { csrfTokenFor } from '../../../http/auth.js';
import type { HttpAccess } from '../../../http/access.js';
import type { AppDeps } from '../../../http/contracts.js';
import { connectionOf } from '../../../http/transport/metadata.js';
import { okEnvelope } from '../../../http/errors.js';
import { envelope, errorResponses, responses } from '../../../http/model.js';
import {
  ApplicationError,
  isUuid,
  notReady,
  unauthorized,
  validationError,
} from '../../../platform/errors.js';

export function createMeController(access: HttpAccess) {
  return new Elysia({ name: 'me', strictPath: true }).get(
    '/api/v1/me',
    async ({ request }) => {
      const actor = await access.requireActor(request);
      return okEnvelope(
        {
          user: { id: actor.ownerId, display_name: actor.displayName },
          csrf_token: csrfTokenFor(actor),
          confirmed_timezone: actor.timezoneId,
        },
        access.requestId(request),
      );
    },
    { response: responses(model.MeSchema) },
  );
}
export function createAccountController(
  deps: Pick<AppDeps, 'accountService' | 'invitedAccountService'>,
  access: HttpAccess,
) {
  function service() {
    if (!deps.accountService) throw notReady();
    return deps.accountService;
  }
  function invited() {
    if (!deps.invitedAccountService) throw notReady('account service unavailable');
    return deps.invitedAccountService;
  }
  async function signed(request: Request, claim = false) {
    const actor = await access.actor(request, claim ? { allowLegacyClaim: true } : undefined);
    if (!actor) throw unauthorized();
    if (!actor.sessionId)
      throw new ApplicationError(403, 'FORBIDDEN', 'signed session required', {
        reason: 'SIGNED_SESSION_REQUIRED',
      });
    return actor;
  }
  function parse(signedSession: boolean, claim = false, target = false) {
    return async ({ request }: { request: Request }) => {
      service();
      if (request.headers.get('origin') !== (process.env.APP_ORIGIN ?? 'http://localhost:3000'))
        throw new ApplicationError(403, 'FORBIDDEN', 'origin mismatch', {
          reason: 'ORIGIN_MISMATCH',
        });
      if (signedSession) access.csrf(request, await signed(request, claim));
      if (target && !isUuid(new URL(request.url).pathname.split('/')[5] ?? ''))
        throw validationError('invalid account resource id');
      return access.json(request);
    };
  }
  function headers(request: Request) {
    const result = new Headers();
    for (const name of ['cookie', 'origin']) {
      const value = request.headers.get(name);
      if (value) result.set(name, value);
    }
    return result;
  }
  function ip(request: Request) {
    return connectionOf(request).remoteAddress ?? 'unknown-peer';
  }
  function cookies(set: { headers: Record<string, string | number | string[]> }, values: string[]) {
    if (values.length) set.headers['set-cookie'] = values;
  }
  function listQuery(request: Request) {
    const params = new URL(request.url).searchParams;
    if (new Set(params.keys()).size !== params.size) throw validationError('duplicate query field');
    const parsed = model.authListQuerySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success) throw validationError('invalid account fields');
    return parsed.data;
  }
  return new Elysia({ name: 'account', strictPath: true })
    .get(
      '/api/v1/auth/status',
      async ({ request }) =>
        okEnvelope(
          await service().status(await access.actor(request, { allowLegacyClaim: true })),
          access.requestId(request),
        ),
      { response: responses(model.authStatusSchema) },
    )
    .get(
      '/api/v1/auth/account',
      async ({ request }) => {
        service();
        const actor = await signed(request);
        if (new URL(request.url).searchParams.size) throw validationError('invalid account query');
        return okEnvelope(await invited().account(actor), access.requestId(request));
      },
      { response: responses(model.AccountViewSchema) },
    )
    .get(
      '/api/v1/auth/invitations',
      async ({ request }) => {
        service();
        const actor = await signed(request);
        return okEnvelope(
          await invited().listInvitations(actor, listQuery(request)),
          access.requestId(request),
        );
      },
      { response: responses(model.authInvitationsSchema) },
    )
    .get(
      '/api/v1/auth/sessions',
      async ({ request }) => {
        service();
        const actor = await signed(request);
        return okEnvelope(
          await invited().sessions(actor, listQuery(request)),
          access.requestId(request),
        );
      },
      { response: responses(model.authSessionsSchema) },
    )
    .get(
      '/api/v1/auth/users',
      async ({ request }) => {
        service();
        const actor = await signed(request);
        return okEnvelope(
          await invited().users(actor, listQuery(request)),
          access.requestId(request),
        );
      },
      { response: responses(model.authUsersSchema) },
    )
    .post(
      '/api/v1/auth/initialize',
      async ({ request, body, set, status }) => {
        const session = await service().initialize(body);
        cookies(set, session.cookies);
        return status(
          201,
          okEnvelope(
            {
              authenticated: true as const,
              workspace_binding: 'pending_local_configuration' as const,
            },
            access.requestId(request),
          ),
        );
      },
      {
        parse: parse(false, false, false),
        body: model.authInitializeSchema,
        response: { 201: envelope(model.authAuthenticatedSchema), ...errorResponses },
      },
    )
    .post(
      '/api/v1/auth/claim',
      async ({ request, body, set }) => {
        const actor = await signed(request, true);
        const session = await service().claim(actor.ownerId, body);
        cookies(set, session.cookies);
        return okEnvelope(
          {
            authenticated: true as const,
            workspace_binding: 'pending_local_configuration' as const,
          },
          access.requestId(request),
        );
      },
      {
        parse: parse(true, true, false),
        body: model.authClaimSchema,
        response: responses(model.authAuthenticatedSchema),
      },
    )
    .post(
      '/api/v1/auth/sign-in',
      async ({ request, body, set }) => {
        const session = await service().signIn(body, ip(request));
        cookies(set, session.cookies);
        return okEnvelope({ authenticated: true as const }, access.requestId(request));
      },
      {
        parse: parse(false, false, false),
        body: model.authSignInSchema,
        response: responses(model.authAuthenticatedSchema),
      },
    )
    .post(
      '/api/v1/auth/sign-out',
      async ({ request, set }) => {
        const actor = await signed(request);
        const session = await service().signOut(actor.sessionId!, actor.ownerId, headers(request));
        cookies(set, session.cookies);
        return okEnvelope({ signed_out: true as const }, access.requestId(request));
      },
      {
        parse: parse(true, false, false),
        body: model.authSignOutSchema,
        response: responses(model.authSignedOutSchema),
      },
    )
    .post(
      '/api/v1/auth/contact/request',
      async ({ request, body, status }) => {
        return status(
          202,
          okEnvelope(
            await invited().requestContact(await signed(request), body, ip(request)),
            access.requestId(request),
          ),
        );
      },
      {
        parse: parse(true, false, false),
        body: model.authContactRequestSchema,
        response: { 202: envelope(model.authContactRequestedSchema), ...errorResponses },
      },
    )
    .post(
      '/api/v1/auth/contact/verify',
      async ({ request, body }) => {
        return okEnvelope(
          await invited().verifyContact(await signed(request), body, ip(request)),
          access.requestId(request),
        );
      },
      {
        parse: parse(true, false, false),
        body: model.ContactVerifyInputSchema,
        response: responses(model.authContactVerifiedSchema),
      },
    )
    .post(
      '/api/v1/auth/invitations',
      async ({ request, body, status }) => {
        const created = await invited().createInvitation(await signed(request), body, ip(request));
        const result = okEnvelope({ invitation: created.invitation }, access.requestId(request));
        return created.replayed ? status(200, result) : status(201, result);
      },
      {
        parse: parse(true, false, false),
        body: model.authInvitationCreateSchema,
        response: {
          200: envelope(model.authInvitationCreatedSchema),
          201: envelope(model.authInvitationCreatedSchema),
          ...errorResponses,
        },
      },
    )
    .post(
      '/api/v1/auth/invitations/accept',
      async ({ request, body, status }) => {
        return status(
          201,
          okEnvelope(
            await invited().acceptInvitation(body, ip(request), await access.actor(request)),
            access.requestId(request),
          ),
        );
      },
      {
        parse: parse(false, false, false),
        body: model.InvitationAcceptInputSchema,
        response: { 201: envelope(model.authInvitationAcceptedSchema), ...errorResponses },
      },
    )
    .post(
      '/api/v1/auth/password/forgot',
      async ({ request, body, status }) => {
        return status(
          202,
          okEnvelope(await invited().forgotPassword(body, ip(request)), access.requestId(request)),
        );
      },
      {
        parse: parse(false, false, false),
        body: model.authPasswordForgotSchema,
        response: { 202: envelope(model.authPasswordForgottenSchema), ...errorResponses },
      },
    )
    .post(
      '/api/v1/auth/password/reset',
      async ({ request, body }) => {
        return okEnvelope(
          await invited().resetPassword(body, ip(request)),
          access.requestId(request),
        );
      },
      {
        parse: parse(false, false, false),
        body: model.PasswordResetInputSchema,
        response: responses(model.authPasswordResetResultSchema),
      },
    )
    .post(
      '/api/v1/auth/password/change',
      async ({ request, body, set }) => {
        const result = await invited().changePassword(
          await signed(request),
          body,
          headers(request),
          ip(request),
        );
        cookies(set, result.cookies);
        return okEnvelope(
          { password_changed: true as const, signed_out: true as const },
          access.requestId(request),
        );
      },
      {
        parse: parse(true, false, false),
        body: model.authPasswordChangeSchema,
        response: responses(model.authPasswordChangedSchema),
      },
    )
    .post(
      '/api/v1/auth/sessions/revoke',
      async ({ request, body, set }) => {
        const result = await invited().revokeSessions(
          await signed(request),
          body,
          headers(request),
          ip(request),
        );
        cookies(set, result.cookies);
        return okEnvelope(
          { revoked: true as const, signed_out: result.signed_out },
          access.requestId(request),
        );
      },
      {
        parse: parse(true, false, false),
        body: model.authSessionsRevokeSchema,
        response: responses(model.authSessionRevokedSchema),
      },
    )
    .post(
      '/api/v1/auth/deletion-request',
      async ({ request, body, set }) => {
        const result = await invited().requestDeletion(
          await signed(request),
          body,
          headers(request),
          ip(request),
        );
        cookies(set, result.cookies);
        return okEnvelope(
          { deletion_requested: true as const, signed_out: true as const },
          access.requestId(request),
        );
      },
      {
        parse: parse(true, false, false),
        body: model.authDeletionRequestSchema,
        response: responses(model.authDeletionRequestedSchema),
      },
    )
    .post(
      '/api/v1/auth/invitations/:id/resend',
      async ({ request, body, params }) => {
        return okEnvelope(
          await invited().resendInvitation(await signed(request), params.id, body, ip(request)),
          access.requestId(request),
        );
      },
      {
        parse: parse(true, false, true),
        body: model.authInvitationResendSchema,
        response: responses(model.authInvitationCreatedSchema),
      },
    )
    .post(
      '/api/v1/auth/invitations/:id/revoke',
      async ({ request, body, params }) => {
        return okEnvelope(
          await invited().revokeInvitation(await signed(request), params.id, body, ip(request)),
          access.requestId(request),
        );
      },
      {
        parse: parse(true, false, true),
        body: model.authInvitationRevokeSchema,
        response: responses(model.authInvitationRevokedSchema),
      },
    )
    .post(
      '/api/v1/auth/sessions/:id/revoke',
      async ({ request, set, params }) => {
        const result = await invited().revokeSession(
          await signed(request),
          params.id,
          headers(request),
        );
        cookies(set, result.cookies);
        return okEnvelope(
          { revoked: true as const, signed_out: result.signed_out },
          access.requestId(request),
        );
      },
      {
        parse: parse(true, false, true),
        body: model.authSessionRevokeSchema,
        response: responses(model.authSessionRevokedSchema),
      },
    )
    .post(
      '/api/v1/auth/users/:id/disable',
      async ({ request, body, params }) => {
        return okEnvelope(
          await invited().disableUser(await signed(request), params.id, body, ip(request)),
          access.requestId(request),
        );
      },
      {
        parse: parse(true, false, true),
        body: model.authDisableUserSchema,
        response: responses(model.authUserDisabledSchema),
      },
    );
}
