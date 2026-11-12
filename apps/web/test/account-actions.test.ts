import { afterEach, describe, expect, it } from 'bun:test';
import {
  authPasswordChangedSchema,
  authInvitationAcceptedSchema,
  authPasswordForgottenSchema,
  authSessionsSchema,
} from '@along/contracts';
import {
  readAccountCollection,
  submitAccountAction,
  takeFragmentToken,
} from '../src/features/account/model/account-actions';
import { validateAccountFields } from '../src/features/account/model/account-operation';
import { safeReturnTo } from '../src/shared/session/navigation';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function response(status: number, data: unknown = null) {
  return Response.json(
    {
      code: status < 300 ? 0 : status,
      data,
      msg: 'result',
      error:
        status < 300
          ? null
          : {
              code:
                status === 401
                  ? 'UNAUTHENTICATED'
                  : status === 429
                    ? 'RATE_LIMITED'
                    : status === 409
                      ? 'STATE_CONFLICT'
                      : 'NOT_READY',
              message: 'operation rejected',
              request_id: 'request',
            },
      request_id: 'request',
    },
    { status, headers: { 'retry-after': '60' } },
  );
}

describe('explicit invited-account action controller states', () => {
  it('captures only fragment tokens into memory and removes fragment/query before any subsequent work', () => {
    const location = { hash: `#token=${'a'.repeat(43)}`, pathname: '/invite' };
    const urls: Array<string | URL | null | undefined> = [];
    const token = takeFragmentToken(location, {
      replaceState(_data, _unused, url) {
        urls.push(url);
      },
    });
    expect(token).toBe('a'.repeat(43));
    expect(urls).toEqual(['/invite']);
    expect(
      takeFragmentToken(
        { hash: '#token=invalid', pathname: '/reset-password' },
        {
          replaceState(_data, _unused, url) {
            urls.push(url);
          },
        },
      ),
    ).toBeNull();
    expect(urls).toEqual(['/invite', '/reset-password']);
    expect(
      takeFragmentToken({ hash: '', pathname: '/verify-contact' }, { replaceState() {} }),
    ).toBeNull();
  });
  it('selects username OR email explicitly, does not infer @, and sends no extra confirmation', () => {
    const fields = new FormData();
    fields.set('login_method', 'email');
    fields.set('email', 'Mixed@Example.COM');
    fields.set('login_name', 'ignored');
    fields.set('password', ' password ');
    expect(validateAccountFields('sign-in', fields)).toEqual({
      ok: true,
      body: { email: 'Mixed@Example.COM', password: ' password ' },
    });
    fields.set('login_method', 'login_name');
    fields.set('login_name', ' User@Name ');
    expect(validateAccountFields('sign-in', fields)).toEqual({
      ok: true,
      body: { login_name: 'user@name', password: ' password ' },
    });
  });
  it('keeps current-password 401 inline and does not read identity, redirect, clear storage or retry', async () => {
    const navigations: string[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { replace: (url: string) => navigations.push(url) } },
    });
    const requests: Array<{
      path: string;
      method: string | undefined;
      body: unknown;
      csrf: string | null;
    }> = [];
    const outcome = await submitAccountAction(
      'password/change',
      { current_password: ' bad password ', new_password: ' new password ' },
      'csrf',
      authPasswordChangedSchema,
      async (path, init) => {
        requests.push({
          path: String(path),
          method: init?.method,
          body: JSON.parse(String(init?.body)),
          csrf: new Headers(init?.headers).get('x-csrf-token'),
        });
        return response(401);
      },
    );
    expect(outcome).toMatchObject({
      kind: 'failure',
      status: 401,
      currentPassword: true,
      uncertain: false,
    });
    expect(requests).toEqual([
      {
        path: '/api/v1/auth/password/change',
        method: 'POST',
        body: { current_password: ' bad password ', new_password: ' new password ' },
        csrf: 'csrf',
      },
    ]);
    expect(navigations).toEqual([]);
  });
  it.each([403, 409, 429, 503])(
    'keeps HTTP %i at the form without POST replay or navigation',
    async (status) => {
      let calls = 0;
      const outcome = await submitAccountAction(
        'password/forgot',
        { email: 'a@example.com' },
        null,
        authPasswordForgottenSchema,
        async () => {
          calls++;
          return response(status);
        },
      );
      expect(calls).toBe(1);
      expect(outcome).toMatchObject({
        kind: 'failure',
        status,
        currentPassword: false,
        uncertain: status === 503,
      });
    },
  );
  it('acceptance creates an account without GET identity, new session assumption or automatic login', async () => {
    const calls: string[] = [];
    const outcome = await submitAccountAction(
      'invitations/accept',
      { token: 'a'.repeat(43), login_name: 'name', display_name: 'Name', password: 'password' },
      null,
      authInvitationAcceptedSchema,
      async (path, init) => {
        calls.push(`${init?.method} ${path}`);
        return response(201, { account_created: true, authenticated: false });
      },
    );
    expect(outcome).toEqual({
      kind: 'success',
      data: { account_created: true, authenticated: false },
    });
    expect(calls).toEqual(['POST /api/v1/auth/invitations/accept']);
  });
  it('treats a lost or malformed successful response as uncertain without resubmission', async () => {
    let calls = 0;
    const lost = await submitAccountAction(
      'password/change',
      {},
      'csrf',
      authPasswordChangedSchema,
      async () => {
        calls++;
        throw new Error('lost');
      },
    );
    expect(lost).toMatchObject({ kind: 'failure', uncertain: true, status: null });
    expect(calls).toBe(1);
    const malformed = await submitAccountAction(
      'password/change',
      {},
      'csrf',
      authPasswordChangedSchema,
      async () => response(200, { password_changed: true }),
    );
    expect(malformed).toMatchObject({ kind: 'failure', uncertain: true, status: 200 });
  });
  it('only protected collection GET 401 safely re-logins, with no stored action or replay', async () => {
    const navigations: string[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { replace: (url: string) => navigations.push(url) } },
    });
    const calls: Array<{ url: string; method?: string }> = [];
    await expect(
      readAccountCollection('sessions', authSessionsSchema, async (url, init) => {
        calls.push({ url: String(url), method: init?.method });
        return response(401);
      }),
    ).rejects.toThrow();
    expect(navigations).toEqual(['/login?returnTo=%2Faccount']);
    expect(calls).toEqual([{ url: '/api/v1/auth/sessions', method: undefined }]);
    navigations.length = 0;
    for (const status of [403, 429, 503])
      await expect(
        readAccountCollection('sessions', authSessionsSchema, async () => response(status)),
      ).rejects.toThrow();
    expect(navigations).toEqual([]);
    for (const target of [
      '/invite#token=secret',
      '/reset-password',
      '/verify-contact',
      '/forgot-password',
    ])
      expect(safeReturnTo(target)).toBe('/');
  });
});
