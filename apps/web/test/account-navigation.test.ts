import { afterEach, describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AccountForm from '../src/features/account/AccountForm';
import {
  loginHref,
  pageReturnTo,
  protectedLoginHref,
  safeReturnTo,
} from '../src/lib/account-navigation';
import { consumeThreadStream, readEnvelope } from '../src/lib/conversation-run';
import type { ThreadEvent } from '@along/stream-protocol';
import {
  submitAccountOperation,
  validateAccountFields,
} from '../src/features/account/account-operation';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

function browserLocation() {
  const navigations: string[] = [];
  const storage: Record<string, unknown> = {
    'run-resume:conversation:run': '{"checkpoint_id":"old"}',
    'run-cancel:conversation:run': 'old-key',
    'document-decision:approval:confirm:hash': 'old-decision',
    unrelated: 'preserved',
  };
  Object.defineProperty(storage, 'removeItem', {
    value: (key: string) => {
      delete storage[key];
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        pathname: '/conversations',
        search: '?conversation_id=original&run_id=original-run',
        replace: (target: string) => {
          navigations.push(target);
        },
      },
      sessionStorage: storage,
    },
  });
  return { navigations, storage };
}

function failedResponse(status: number) {
  return Response.json(
    {
      code: status === 401 ? 40101 : status === 403 ? 40301 : 50301,
      data: null,
      msg: 'failed',
      error: {
        code: status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : 'NOT_READY',
        message: 'precise error',
        request_id: 'request-auth',
      },
      request_id: 'request-auth',
    },
    { status },
  );
}

describe('safe read-only re-login destinations', () => {
  it.each([
    'https://evil.example/path',
    '//evil.example',
    '/\\evil.example',
    '/\\[',
    '/%5cevil.example',
    '/%2fevil.example',
    '/%252fevil.example',
    '/%255cevil.example',
    '/%25252fevil.example',
    '/login',
    '/LOGIN?returnTo=/tasks',
    '/login/nested',
    '/%6cogin',
    '/%256cogin',
    '/tasks/../login',
    '/tasks/%2e%2e/login',
    '/setup',
    '/logout',
    '/claim',
    '/CLAIM?returnTo=/tasks',
    '/%63laim',
    '/%2563laim',
    '/tasks/../claim',
    '/api/v1/auth/sign-out',
    '/tasks\n//evil.example',
    '/tasks/%0a',
    '/tasks/%',
    '',
    null,
    ['//evil.example'],
  ])('rejects unsafe or looping destination %j', (candidate) => {
    expect(safeReturnTo(candidate)).toBe('/');
  });

  it('retains original task/approval/Run path and necessary query without a request body', () => {
    const target = pageReturnTo('/conversations', {
      conversation_id: 'original',
      run_id: 'original-run',
      filter: ['a', 'b'],
      omitted: undefined,
    });
    expect(safeReturnTo(target)).toBe(
      '/conversations?conversation_id=original&run_id=original-run&filter=a&filter=b',
    );
    const login = new URL(loginHref(target), 'http://web.test');
    expect(login.pathname).toBe('/login');
    expect([...login.searchParams.keys()]).toEqual(['returnTo']);
    expect(login.searchParams.get('returnTo')).toBe(target);
    expect(safeReturnTo('/approvals/one?conversation_id=old&run_id=run')).toBe(
      '/approvals/one?conversation_id=old&run_id=run',
    );
  });

  it('preserves encoded query spaces and literal percent values through login and return', () => {
    const target =
      '/tasks?q=hello%20world&progress=100%25&source=https%3A%2F%2Fexample.test%2Fnotes';
    expect(safeReturnTo(target)).toBe(target);
    const login = new URL(loginHref(target), 'http://web.test');
    expect(safeReturnTo(login.searchParams.get('returnTo'))).toBe(target);
    expect(pageReturnTo('/tasks', { q: 'hello world', progress: '100%' })).toBe(
      '/tasks?q=hello+world&progress=100%25',
    );
  });

  it.each([0, 200, 400, 403, 409, 503])(
    'does not interpret HTTP %i as expired identity',
    (status) => {
      expect(protectedLoginHref(status, '/tasks/one')).toBeNull();
    },
  );
});

describe('actual protected response consumers at the re-login boundary', () => {
  it('redirects protected HTTP401 to the original GET location and drops persisted action retries', async () => {
    const browser = browserLocation();
    await expect(readEnvelope(failedResponse(401))).rejects.toThrow('原操作不会自动重放');
    expect(browser.navigations).toEqual([
      '/login?returnTo=%2Fconversations%3Fconversation_id%3Doriginal%26run_id%3Doriginal-run',
    ]);
    expect(Object.keys(browser.storage)).toEqual(['unrelated']);
  });

  it('still redirects real HTTP401 when browser storage access is disabled', async () => {
    const browser = browserLocation();
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('Storage disabled');
      },
    });
    await expect(readEnvelope(failedResponse(401))).rejects.toThrow('会话已过期');
    expect(browser.navigations).toHaveLength(1);
  });

  it.each([403, 503])(
    'keeps HTTP%i as an accurate error without navigation or retry removal',
    async (status) => {
      const browser = browserLocation();
      await expect(readEnvelope(failedResponse(status))).rejects.toThrow('precise error');
      expect(browser.navigations).toEqual([]);
      expect(browser.storage['run-resume:conversation:run']).toBeDefined();
    },
  );

  it('redirects the initial SSE HTTP401 before consuming events', async () => {
    const browser = browserLocation();
    const events: ThreadEvent[] = [];
    await expect(
      consumeThreadStream(failedResponse(401), (event) => events.push(event)),
    ).rejects.toThrow('会话已过期');
    expect(events).toEqual([]);
    expect(browser.navigations).toHaveLength(1);
  });

  it('never mistakes an established stream business failure for HTTP401', async () => {
    const browser = browserLocation();
    const event = {
      protocol_version: 'v1',
      seq: 1,
      type: 'thread.failed',
      request_id: 'request-auth',
      payload: {
        conversation_id: '11111111-1111-4111-8111-111111111111',
        run_id: '22222222-2222-4222-8222-222222222222',
        error: { code: 'UNAUTHENTICATED', message: 'business failure', http_status: 401 },
      },
    };
    const events: ThreadEvent[] = [];
    await consumeThreadStream(
      new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }),
      (value) => events.push(value),
    );
    expect(events.map((value) => value.type)).toEqual(['thread.failed']);
    expect(browser.navigations).toEqual([]);
  });
});

describe('account operation response boundaries', () => {
  it('validates with the public contract without trimming passwords or sending confirmation fields', () => {
    const fields = new FormData();
    fields.set('display_name', '  原用户  ');
    fields.set('login_name', '  Admin  ');
    fields.set('password', ' password ');
    fields.set('password_confirmation', ' password ');
    expect(validateAccountFields('initialize', fields)).toEqual({
      ok: true,
      body: { display_name: '原用户', login_name: 'admin', password: ' password ' },
    });
    fields.set('password_confirmation', 'password');
    const mismatch = validateAccountFields('initialize', fields);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(Object.keys(mismatch.fieldErrors)).toContain('password_confirmation');
  });

  it('requires explicit confirmation for claim and sends no target identity', () => {
    const fields = new FormData();
    fields.set('login_name', 'Admin');
    fields.set('password', 'password');
    fields.set('password_confirmation', 'password');
    expect(validateAccountFields('claim', fields).ok).toBe(false);
    fields.set('confirmed', 'on');
    expect(validateAccountFields('claim', fields)).toEqual({
      ok: true,
      body: { login_name: 'admin', password: 'password', confirmed: true },
    });
  });

  it.each([403, 503])(
    'does not sign out, redirect or discard retry state on HTTP%i',
    async (status) => {
      const browser = browserLocation();
      const requests: Array<{
        path: string;
        method?: string;
        csrf: string | null;
        body?: BodyInit | null;
      }> = [];
      const outcome = await submitAccountOperation(
        'sign-out',
        {},
        'current-csrf',
        async (input, init) => {
          requests.push({
            path: String(input),
            method: init?.method,
            csrf: new Headers(init?.headers).get('x-csrf-token'),
            body: init?.body,
          });
          return failedResponse(status);
        },
      );
      expect(outcome.kind).toBe(status === 503 ? 'unconfirmed' : 'rejected');
      expect(requests).toEqual([
        {
          path: '/api/v1/auth/sign-out',
          method: 'POST',
          csrf: 'current-csrf',
          body: '{}',
        },
      ]);
      expect(browser.navigations).toEqual([]);
      expect(browser.storage['run-resume:conversation:run']).toBeDefined();
    },
  );

  it('keeps a lost sign-out response unknown without retrying the POST', async () => {
    let requests = 0;
    const outcome = await submitAccountOperation('sign-out', {}, 'current-csrf', async () => {
      requests++;
      throw new TypeError('connection lost');
    });
    expect(outcome.kind).toBe('unconfirmed');
    expect(requests).toBe(1);
  });

  it('requires the signed-out acknowledgement rather than any successful HTTP response', async () => {
    const outcome = await submitAccountOperation('sign-out', {}, 'current-csrf', async () =>
      Response.json({
        code: 0,
        msg: 'ok',
        request_id: 'request-account',
        data: { authenticated: true },
      }),
    );
    expect(outcome.kind).toBe('unconfirmed');
  });

  it('reads canonical identity after login and never carries an account body into the GET', async () => {
    const requests: Array<{ path: string; method: string; body: BodyInit | null | undefined }> = [];
    const outcome = await submitAccountOperation(
      'sign-in',
      { login_name: 'admin', password: ' password ' },
      null,
      async (input, init) => {
        requests.push({ path: String(input), method: init?.method ?? 'GET', body: init?.body });
        return Response.json({
          code: 0,
          msg: 'ok',
          request_id: 'request-account',
          data:
            String(input) === '/api/v1/me'
              ? {
                  user: { id: '11111111-1111-4111-8111-111111111111', display_name: '原用户' },
                  csrf_token: 'current-csrf',
                  confirmed_timezone: null,
                }
              : { authenticated: true },
        });
      },
    );
    expect(outcome).toEqual({ kind: 'authenticated', workspacePending: false });
    expect(requests).toEqual([
      {
        path: '/api/v1/auth/sign-in',
        method: 'POST',
        body: JSON.stringify({ login_name: 'admin', password: ' password ' }),
      },
      { path: '/api/v1/me', method: 'GET', body: undefined },
    ]);
  });

  it('preserves an accepted claim when identity verification fails instead of allowing a new claim', async () => {
    const requests: string[] = [];
    const outcome = await submitAccountOperation(
      'claim',
      { login_name: 'admin', password: 'password', confirmed: true },
      'current-csrf',
      async (input) => {
        requests.push(String(input));
        return String(input) === '/api/v1/me'
          ? failedResponse(503)
          : Response.json({
              code: 0,
              msg: 'ok',
              request_id: 'request-account',
              data: { authenticated: true, workspace_binding: 'pending_local_configuration' },
            });
      },
    );
    expect(outcome.kind).toBe('accepted-unverified');
    if (outcome.kind === 'accepted-unverified') expect(outcome.workspacePending).toBe(true);
    expect(requests).toEqual(['/api/v1/auth/claim', '/api/v1/me']);
  });

  it('requires a fresh state read after an initialization race', async () => {
    const outcome = await submitAccountOperation(
      'initialize',
      { display_name: '原用户', login_name: 'admin', password: 'password' },
      null,
      async () =>
        Response.json(
          {
            code: 409,
            msg: 'conflict',
            request_id: 'request-account',
            error: {
              code: 'STATE_CONFLICT',
              message: 'initialization closed',
              request_id: 'request-account',
            },
          },
          { status: 409 },
        ),
    );
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.rereadRequired).toBe(true);
  });
});

describe('account navigation semantics', () => {
  it('exposes the sign-out return action as a link rather than a button', async () => {
    const markup = renderToStaticMarkup(
      createElement(AccountForm, { operation: 'sign-out', csrfToken: 'csrf-fixture' }),
    );
    const roles: string[] = [];
    await new HTMLRewriter()
      .on('form a[href="/account"]', {
        element(element) {
          roles.push(element.getAttribute('role') ?? 'link');
        },
      })
      .transform(new Response(markup))
      .text();
    expect(roles).toEqual(['link']);
  });
});
