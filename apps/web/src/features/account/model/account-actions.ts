import { z } from 'zod';
import { EnvelopeSchema } from '@along/contracts';
import { clearAppRetryState, protectedLoginHref } from '@/shared/session/navigation';

export type AccountRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ActionState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; data: unknown }
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
export async function submitAccountAction(
  path: string,
  body: unknown,
  csrfToken: string | null,
  schema: z.ZodType,
  request: AccountRequest = fetch,
): Promise<ActionState> {
  let response: Response;
  try {
    response = await request(`/api/v1/auth/${path}`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(csrfToken !== null ? { 'x-csrf-token': csrfToken } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      kind: 'failure',
      status: null,
      message: '连接中断，结果未知。请先只读核对账户状态，不会自动重发。',
      uncertain: true,
      currentPassword: false,
    };
  }
  const envelope = EnvelopeSchema.safeParse(await response.json().catch(() => null));
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
  path: string,
  schema: z.ZodType<T>,
  request: AccountRequest = fetch,
): Promise<T> {
  const response = await request(`/api/v1/auth/${path}`, { cache: 'no-store' });
  const login = protectedLoginHref(response.status, '/account');
  if (login && typeof window !== 'undefined') {
    clearAppRetryState();
    window.location.replace(login);
  }
  const envelope = EnvelopeSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !envelope.success || envelope.data.code !== 0) {
    throw new Error(
      envelope.success
        ? (envelope.data.error?.message ?? '读取失败，请手动重试。')
        : '读取失败，请手动重试。',
    );
  }
  return schema.parse(envelope.data.data);
}
