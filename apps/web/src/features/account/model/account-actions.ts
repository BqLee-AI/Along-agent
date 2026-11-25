import { z } from 'zod';
import * as auth from '@along/contracts';
import { EnvelopeSchema } from '@along/contracts';
import { createBrowserApi, writeOptions } from '@/shared/http/eden';
import { clearAppRetryState, protectedLoginHref } from '@/shared/session/navigation';

export type AccountRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type AccountActionPath =
  | 'account/profile'
  | 'contact/request'
  | 'contact/verify'
  | 'password/change'
  | 'password/forgot'
  | 'password/reset'
  | 'invitations'
  | 'invitations/accept'
  | 'sessions/revoke'
  | 'deletion-request'
  | { kind: 'invitation-resend' | 'invitation-revoke' | 'user-disable'; id: string };
export type AccountCollection = 'invitations' | 'sessions' | 'users';

function accountActionRequest(
  path: AccountActionPath,
  body: unknown,
  csrf: string | null,
  request: AccountRequest,
) {
  const api = createBrowserApi(request).api.v1.auth;
  const options = writeOptions(csrf);
  if (typeof path !== 'string') {
    switch (path.kind) {
      case 'invitation-resend':
        return api
          .invitations({ id: encodeURIComponent(path.id) })
          .resend.post(auth.authInvitationResendSchema.parse(body), options);
      case 'invitation-revoke':
        return api
          .invitations({ id: encodeURIComponent(path.id) })
          .revoke.post(auth.authInvitationRevokeSchema.parse(body), options);
      case 'user-disable':
        return api
          .users({ id: encodeURIComponent(path.id) })
          .disable.post(auth.authDisableUserSchema.parse(body), options);
    }
  }
  switch (path) {
    case 'account/profile':
      return api.account.profile.post(auth.authAccountProfileUpdateSchema.parse(body), options);
    case 'contact/request':
      return api.contact.request.post(auth.authContactRequestSchema.parse(body), options);
    case 'contact/verify':
      return api.contact.verify.post(auth.authContactVerifySchema.parse(body), options);
    case 'password/change':
      return api.password.change.post(auth.authPasswordChangeSchema.parse(body), options);
    case 'password/forgot':
      return api.password.forgot.post(auth.authPasswordForgotSchema.parse(body), options);
    case 'password/reset':
      return api.password.reset.post(auth.authPasswordResetSchema.parse(body), options);
    case 'invitations':
      return api.invitations.post(auth.authInvitationCreateSchema.parse(body), options);
    case 'invitations/accept':
      return api.invitations.accept.post(auth.authInvitationAcceptSchema.parse(body), options);
    case 'sessions/revoke':
      return api.sessions.revoke.post(auth.authSessionsRevokeSchema.parse(body), options);
    case 'deletion-request':
      return api['deletion-request'].post(auth.authDeletionRequestSchema.parse(body), options);
  }
}

export type ActionState<T = unknown> =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; data: T }
  | {
      kind: 'failure';
      status: number | null;
      message: string;
      uncertain: boolean;
      currentPassword: boolean;
    };

/** Tokens never enter search params, storage, server props, or a GET request. */
export function takeFragmentToken(
  location: Pick<Location, 'hash' | 'pathname'>,
  history: Pick<History, 'replaceState'>,
): string | null {
  const fragment = location.hash;
  history.replaceState(null, '', location.pathname);
  const token = new URLSearchParams(fragment.slice(1)).get('token');
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

/** One explicit submission. Failures never navigate or replay an account write. */
export async function submitAccountAction<T>(
  path: AccountActionPath,
  body: unknown,
  csrfToken: string | null,
  schema: z.ZodType<T>,
  request: AccountRequest = fetch,
): Promise<ActionState<T>> {
  let result;
  try {
    result = await accountActionRequest(path, body, csrfToken, request);
  } catch {
    return {
      kind: 'failure',
      status: null,
      message: '连接中断，结果未知。请先只读核对账户状态，不会自动重发。',
      uncertain: true,
      currentPassword: false,
    };
  }
  const { response } = result;
  const envelope = EnvelopeSchema.safeParse(result.error ? result.error.value : result.data);
  const data =
    envelope.success && envelope.data.code === 0 ? schema.safeParse(envelope.data.data) : null;
  if (response.ok && data?.success) return { kind: 'success', data: data.data };
  const currentPassword =
    response.status === 401 &&
    typeof body === 'object' &&
    body !== null &&
    'current_password' in body;
  return {
    kind: 'failure',
    status: response.status,
    currentPassword,
    uncertain: response.ok || response.status >= 500,
    message: currentPassword
      ? '当前密码验证失败，请检查密码。会话未被自动退出。'
      : response.status === 429
        ? `请求过于频繁，请稍后手动重试${response.headers.get('retry-after') ? `（至少 ${response.headers.get('retry-after')} 秒）` : ''}。`
        : envelope.success && envelope.data.error
          ? envelope.data.error.message
          : '未收到可核验回执，请先只读核对账户状态；不会自动重发。',
  };
}

/** Read-only protected pagination; only a real GET 401 is a re-login boundary. */
export async function readAccountCollection<T>(
  path: AccountCollection,
  schema: z.ZodType<T>,
  request: AccountRequest = fetch,
  cursor: string | null = null,
): Promise<T> {
  const api = createBrowserApi(request).api.v1.auth;
  const options = { query: { ...(cursor !== null ? { cursor } : {}) } };
  const result =
    path === 'invitations'
      ? await api.invitations.get(options)
      : path === 'sessions'
        ? await api.sessions.get(options)
        : await api.users.get(options);
  const { response } = result;
  const login = protectedLoginHref(response.status, '/account');
  if (login && typeof window !== 'undefined') {
    clearAppRetryState();
    window.location.replace(login);
  }
  const envelope = EnvelopeSchema.safeParse(result.error ? result.error.value : result.data);
  if (!response.ok || !envelope.success || envelope.data.code !== 0) {
    throw new Error(
      envelope.success
        ? (envelope.data.error?.message ?? '读取失败，请手动重试。')
        : '读取失败，请手动重试。',
    );
  }
  return schema.parse(envelope.data.data);
}
