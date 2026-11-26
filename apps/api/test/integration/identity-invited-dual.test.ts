import { createFixtureConversation } from '../helpers/bot-conversation.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  AccountViewSchema,
  EnvelopeSchema,
  authContactRequestedSchema,
  authContactVerifiedSchema,
  authInvitationCreatedSchema,
  authInvitationAcceptedSchema,
  authInvitationsSchema,
  authSessionsSchema,
  authUsersSchema,
  authPasswordChangedSchema,
  authPasswordForgottenSchema,
  authPasswordResetResultSchema,
  authSessionRevokedSchema,
  authUserDisabledSchema,
  authDeletionRequestedSchema,
} from '@along/contracts';
import { handleRequest } from '../helpers/http-app.js';
import type { AppDeps } from '../../src/http/contracts.js';
import { createConfiguredAccountService } from '../../src/bootstrap/identity.js';
import { createInvitedAccountService } from '../../src/features/identity/account/invited-service.js';
import {
  openIdentity,
  parseIdentityKeyring,
} from '../../src/features/identity/security/email-security.js';
import { identityKeyfileFixture } from '../helpers/identity-security.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

interface Session {
  cookie: string;
  csrf: string;
  userId: string;
}
interface Reply {
  status: number;
  headers: Headers;
  body: z.infer<typeof EnvelopeSchema>;
}
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const secret = 'isolated-dual-boundary-secret-only';
const originalOrigin = process.env.APP_ORIGIN;
const originalSecret = process.env.BETTER_AUTH_SECRET;
const password = 'isolated dual boundary password ';
const replacement = 'isolated dual replacement password ';
const recovered = 'isolated dual recovered password ';
function data<T>(reply: Reply, status: number, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  expect(reply.status).toBe(status);
  expect(reply.headers.get('cache-control')).toBe('no-store');
  return schema.parse(reply.body.data);
}

suite('invited accounts signed dual public boundary', () => {
  let database: IntegrationDatabase | undefined;
  let server: Server | undefined;
  beforeEach(() => {
    process.env.APP_ORIGIN = origin;
    process.env.BETTER_AUTH_SECRET = secret;
  });
  afterEach(async () => {
    if (originalOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = originalOrigin;
    if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalSecret;
    if (server) {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      server.closeAllConnections();
      await closed.promise;
      server = undefined;
    }
    await database?.close();
    database = undefined;
  });

  for (const mode of ['local', 'http'] as const) {
    it(`${mode}: enforces current owner, role, cursor, credential and signed-session transitions`, async () => {
      database = await createIntegrationDatabase();
      const pool = database.pool;
      const keys = parseIdentityKeyring(identityKeyfileFixture());
      const deps: AppDeps = {
        pool,
        tzdbVersion: 'fixture-v1',
        accountService: createConfiguredAccountService(pool, {
          secret,
          origin,
          keys,
          workspaceStatus: async () => ({ state: 'unconfigured', ownerIds: [] }),
        }),
        invitedAccountService: createInvitedAccountService(pool, {
          secret,
          origin,
          keys,
          mail: {
            origin,
            from: 'isolated@example.test',
            send: async () => {
              throw new Error('this public-boundary fixture must never submit external mail');
            },
          },
        }),
      };
      let base = '';
      let dropNextAcceptance = false;
      if (mode === 'http') {
        server = createServer((req, res) => {
          if (dropNextAcceptance && req.url === '/api/v1/auth/invitations/accept') {
            dropNextAcceptance = false;
            // sendJson reaches end only after the real application COMMIT.
            res.end = (() => {
              res.destroy();
              return res;
            }) as ServerResponse['end'];
          }
          void handleRequest(req, res, deps);
        });
        const listening = Promise.withResolvers<void>();
        server.once('error', listening.reject);
        server.listen(0, '127.0.0.1', listening.resolve);
        await listening.promise;
        server.off('error', listening.reject);
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      }
      async function request(
        path: string,
        method = 'GET',
        body?: unknown,
        session?: Session,
        csrf?: string,
      ): Promise<Reply> {
        const headers: Record<string, string> = { origin };
        if (session) {
          headers.cookie = session.cookie;
          headers['x-csrf-token'] = csrf ?? session.csrf;
        }
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (mode === 'http') {
          const response = await fetch(`${base}/api/v1${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'manual',
          });
          return {
            status: response.status,
            headers: response.headers,
            body: EnvelopeSchema.parse(await response.json()),
          };
        }
        const req = Object.assign(
          Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
          {
            method,
            url: `/api/v1${path}`,
            headers,
            socket: { remoteAddress: '127.0.0.1' },
          },
        ) as unknown as IncomingMessage;
        let status = 0,
          payload = '';
        const output = new Headers();
        const response = Object.assign(new EventEmitter(), {
          headersSent: false,
          setHeader(name: string, value: string | string[]) {
            output.delete(name);
            for (const item of Array.isArray(value) ? value : [value]) output.append(name, item);
          },
          getHeader(name: string) {
            return output.get(name) ?? undefined;
          },
          writeHead(code: number, values: Record<string, string>) {
            status = code;
            this.headersSent = true;
            for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
          },
          write(value: string) {
            payload += value;
            return true;
          },
          end(value?: string) {
            if (value) payload += value;
            response.emit('finish');
          },
        });
        await handleRequest(req, response as unknown as ServerResponse, deps);
        return { status, headers: output, body: EnvelopeSchema.parse(JSON.parse(payload)) };
      }
      async function sessionFrom(reply: Reply): Promise<Session> {
        expect(reply.status).toBeOneOf([200, 201]);
        const cookie = reply.headers
          .getSetCookie()
          .map((item) => item.split(';')[0])
          .join('; ');
        expect(cookie).toContain('better-auth.session_token=');
        const me = await request('/me', 'GET', undefined, { cookie, csrf: '', userId: '' });
        const parsed = data(
          me,
          200,
          z.object({ user: z.object({ id: z.string() }), csrf_token: z.string() }).passthrough(),
        );
        return { cookie, csrf: parsed.csrf_token, userId: parsed.user.id };
      }
      async function token(purpose: string): Promise<string> {
        const row = (
          await pool.query(
            `SELECT d.* FROM identity_mail_deliveries d JOIN identity_challenges c ON c.id=d.challenge_id
           WHERE c.purpose=$1 AND d.payload_ciphertext IS NOT NULL ORDER BY d.created_at DESC,d.id DESC LIMIT 1`,
            [purpose],
          )
        ).rows[0];
        if (!row) throw new Error('isolated queued delivery missing');
        return z
          .object({ token: z.string() })
          .passthrough()
          .parse(
            JSON.parse(
              openIdentity(
                keys,
                {
                  ciphertext: row.payload_ciphertext,
                  nonce: row.payload_nonce,
                  tag: row.payload_tag,
                  encryption_key_id: row.encryption_key_id,
                },
                `identity:delivery:${row.id}:${row.challenge_id}:${row.purpose}:${row.generation}`,
              ),
            ),
          ).token;
      }
      async function invite(email: string) {
        const input = { email, current_password: password, idempotency_key: randomUUID() };
        const created = data(
          await request('/auth/invitations', 'POST', input, admin),
          201,
          authInvitationCreatedSchema,
        );
        const replay = data(
          await request('/auth/invitations', 'POST', input, admin),
          200,
          authInvitationCreatedSchema,
        );
        expect(replay).toEqual(created);
        return { id: created.invitation.id, token: await token('invitation') };
      }

      const admin = await sessionFrom(
        await request('/auth/initialize', 'POST', {
          login_name: 'boundary_admin',
          password,
          display_name: 'Boundary administrator',
        }),
      );
      data(
        await request(
          '/auth/contact/request',
          'POST',
          { email: 'admin@example.test', current_password: password },
          admin,
        ),
        202,
        authContactRequestedSchema,
      );
      data(
        await request(
          '/auth/contact/verify',
          'POST',
          { token: await token('verify_contact') },
          admin,
        ),
        200,
        authContactVerifiedSchema,
      );
      const invitation = await invite('member@example.test');
      const acceptance = {
        token: invitation.token,
        login_name: 'boundary_member',
        password,
        display_name: 'Boundary member',
      };
      if (mode === 'http') {
        dropNextAcceptance = true;
        await expect(request('/auth/invitations/accept', 'POST', acceptance)).rejects.toThrow();
        const retry = await request('/auth/invitations/accept', 'POST', acceptance);
        expect(retry.status).toBe(409);
        expect(retry.headers.getSetCookie()).toEqual([]);
        expect(
          (
            await pool.query(
              `SELECT count(*)::int n FROM identity_account_admissions WHERE invitation_id=$1`,
              [invitation.id],
            )
          ).rows[0].n,
        ).toBe(1);
      } else {
        const accepted = await request('/auth/invitations/accept', 'POST', acceptance);
        data(accepted, 201, authInvitationAcceptedSchema);
        expect(accepted.headers.getSetCookie()).toEqual([]);
      }
      let member = await sessionFrom(
        await request('/auth/sign-in', 'POST', { login_name: 'boundary_member', password }),
      );
      const otherSession = await sessionFrom(
        await request('/auth/sign-in', 'POST', { email: ' MEMBER@example.test ', password }),
      );
      expect(otherSession.userId).toBe(member.userId);
      const account = data(
        await request('/auth/account', 'GET', undefined, member),
        200,
        AccountViewSchema,
      );
      expect(account.installation_admin).toBe(false);
      expect(account.workspace).toEqual({ count: 0, state: 'none' });
      expect(account.contact.state).toBe('verified');
      for (const path of ['/auth/users', '/auth/invitations'])
        expect((await request(path, 'GET', undefined, member)).status).toBe(403);
      expect(
        (
          await request(
            '/auth/invitations',
            'POST',
            {
              email: 'forbidden@example.test',
              current_password: password,
              idempotency_key: randomUUID(),
            },
            member,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await request(
            '/auth/sessions/revoke',
            'POST',
            { scope: 'all', current_password: password },
            member,
            'wrong-csrf',
          )
        ).status,
      ).toBe(403);
      const adminSessions = data(
        await request('/auth/sessions', 'GET', undefined, admin),
        200,
        authSessionsSchema,
      );
      expect(
        (await request(`/auth/sessions/${adminSessions.items[0]!.id}/revoke`, 'POST', {}, member))
          .status,
      ).toBe(404);
      const page = data(
        await request('/auth/sessions?limit=1', 'GET', undefined, member),
        200,
        authSessionsSchema,
      );
      expect(page.next_cursor).not.toBeNull();
      expect(
        (
          await request(
            `/auth/sessions?cursor=${encodeURIComponent(page.next_cursor!)}`,
            'GET',
            undefined,
            admin,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await request(
            `/auth/invitations?cursor=${encodeURIComponent(page.next_cursor!)}`,
            'GET',
            undefined,
            admin,
          )
        ).status,
      ).toBe(400);
      const conversation = randomUUID();
      await createFixtureConversation(pool, member.userId, { id: conversation });
      expect(
        (await request(`/conversations/${conversation}/messages`, 'GET', undefined, member)).status,
      ).toBe(200);
      expect(
        (await request(`/conversations/${conversation}/messages`, 'GET', undefined, admin)).status,
      ).toBe(403);
      data(
        await request(`/auth/sessions/${page.items[0]!.id}/revoke`, 'POST', {}, member),
        200,
        authSessionRevokedSchema,
      );
      expect((await request('/me', 'GET', undefined, otherSession)).status).toBe(401);
      const badPassword = await request(
        '/auth/password/change',
        'POST',
        { current_password: 'incorrect password', new_password: replacement },
        member,
      );
      expect(badPassword.status).toBe(401);
      expect(badPassword.headers.getSetCookie()).toEqual([]);
      expect((await request('/auth/account', 'GET', undefined, member)).status).toBe(200);
      const changed = await request(
        '/auth/password/change',
        'POST',
        { current_password: password, new_password: replacement },
        member,
      );
      data(changed, 200, authPasswordChangedSchema);
      expect(changed.headers.getSetCookie().some((item) => /Max-Age=0/i.test(item))).toBe(true);
      expect((await request('/me', 'GET', undefined, member)).status).toBe(401);
      expect(
        (await request('/auth/sign-in', 'POST', { login_name: 'boundary_member', password }))
          .status,
      ).toBe(401);
      member = await sessionFrom(
        await request('/auth/sign-in', 'POST', {
          email: 'member@example.test',
          password: replacement,
        }),
      );
      data(
        await request('/auth/password/forgot', 'POST', { email: 'absent@example.test' }),
        202,
        authPasswordForgottenSchema,
      );
      data(
        await request('/auth/password/forgot', 'POST', { email: 'member@example.test' }),
        202,
        authPasswordForgottenSchema,
      );
      const reset = await request('/auth/password/reset', 'POST', {
        token: await token('reset_password'),
        new_password: recovered,
      });
      data(reset, 200, authPasswordResetResultSchema);
      expect(reset.headers.getSetCookie()).toEqual([]);
      expect((await request('/me', 'GET', undefined, member)).status).toBe(401);
      member = await sessionFrom(
        await request('/auth/sign-in', 'POST', {
          login_name: 'boundary_member',
          password: recovered,
        }),
      );
      const revoked = await invite('revoked@example.test');
      data(
        await request(
          `/auth/invitations/${revoked.id}/resend`,
          'POST',
          { current_password: password, idempotency_key: randomUUID() },
          admin,
        ),
        200,
        authInvitationCreatedSchema,
      );
      expect(
        (
          await request(
            `/auth/invitations/${revoked.id}/revoke`,
            'POST',
            { current_password: password },
            admin,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await request('/auth/invitations/accept', 'POST', {
            token: await token('invitation'),
            login_name: 'revoked',
            password,
            display_name: 'Revoked',
          })
        ).status,
      ).toBe(409);
      data(await request('/auth/invitations', 'GET', undefined, admin), 200, authInvitationsSchema);
      expect(
        data(await request('/auth/users', 'GET', undefined, admin), 200, authUsersSchema)
          .items.map((item) => item.id)
          .sort(),
      ).toEqual([admin.userId, member.userId].sort());
      const revokeAll = await request(
        '/auth/sessions/revoke',
        'POST',
        { scope: 'all', current_password: recovered },
        member,
      );
      data(revokeAll, 200, authSessionRevokedSchema);
      expect(revokeAll.headers.getSetCookie().some((item) => /Max-Age=0/i.test(item))).toBe(true);
      expect((await request('/me', 'GET', undefined, member)).status).toBe(401);
      member = await sessionFrom(
        await request('/auth/sign-in', 'POST', {
          login_name: 'boundary_member',
          password: recovered,
        }),
      );
      data(
        await request(
          `/auth/users/${member.userId}/disable`,
          'POST',
          { current_password: password, confirmed: true },
          admin,
        ),
        200,
        authUserDisabledSchema,
      );
      expect((await request('/auth/account', 'GET', undefined, member)).status).toBe(401);
      expect(
        (await request(`/conversations/${conversation}/messages`, 'GET', undefined, member)).status,
      ).toBe(401);
      const deletionInvite = await invite('deletion@example.test');
      const acceptedDeletion = await request('/auth/invitations/accept', 'POST', {
        token: deletionInvite.token,
        login_name: 'boundary_delete',
        password,
        display_name: 'Deletion member',
      });
      data(acceptedDeletion, 201, authInvitationAcceptedSchema);
      const deletion = await sessionFrom(
        await request('/auth/sign-in', 'POST', { login_name: 'boundary_delete', password }),
      );
      data(
        await request(
          '/auth/deletion-request',
          'POST',
          { current_password: password, confirmed: true },
          deletion,
        ),
        200,
        authDeletionRequestedSchema,
      );
      expect((await request('/me', 'GET', undefined, deletion)).status).toBe(401);
      expect(
        (await pool.query('SELECT status FROM users WHERE id=$1', [deletion.userId])).rows[0]
          .status,
      ).toBe('deleted_requested');
      expect(
        (
          await request(
            '/auth/deletion-request',
            'POST',
            { current_password: password, confirmed: true },
            admin,
          )
        ).status,
      ).toBe(409);
    }, 30_000);
  }
});
