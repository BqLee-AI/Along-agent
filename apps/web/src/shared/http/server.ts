import 'server-only';

// Server-side API access. The browser uses the same-origin proxy at
// /api/v1/*; server components forward the incoming session cookie.
import { cookies } from 'next/headers';
import { EnvelopeSchema } from '@along/contracts';
import { treaty } from '@elysia/eden';
import type { App } from '@along/api/client-type';
import type { JsonCall } from './eden';
import { decodeJsonResponse, throwTransportError } from './eden';
import { redirect } from 'next/navigation';
import { protectedLoginHref } from '../session/navigation';

const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000';

import type { ApiResult } from './result';
export type { ApiResult } from './result';

export async function apiGet<T>(call: JsonCall<T>, returnTo?: string): Promise<ApiResult<T>> {
  const cookie = (await cookies()).toString();
  let received: Response | undefined;
  const client = treaty<App>(API_BASE, {
    parseDate: false,
    throwHttpError: throwTransportError,
    onResponse: decodeJsonResponse,
    fetch: { cache: 'no-store' },
    headers: cookie ? { cookie } : {},
    fetcher: new Proxy(fetch, {
      async apply(target, _thisArg, args: Parameters<typeof fetch>) {
        const response = await target(...args);
        received = response;
        if (returnTo !== undefined && response.status === 401) {
          // Stop before Eden clones or reads the body. Redirect outside Eden.
          void response.body?.cancel().catch(() => undefined);
          throw new Error('Protected API request requires login');
        }
        return response;
      },
    }),
  });
  let result;
  try {
    result = await call(client);
  } catch {
    // If headers arrived, preserve their status and request ID despite a body read failure.
  }
  const response = result?.response ?? received;
  if (!response)
    return {
      ok: false,
      status: 0,
      code: null,
      requestId: null,
      message: '无法连接 API，请确认服务已启动。',
    };
  if (returnTo !== undefined) {
    const login = protectedLoginHref(response.status, returnTo);
    if (login) redirect(login);
  }
  const parsed = EnvelopeSchema.safeParse(result?.error?.value ?? result?.data);
  const envelope = parsed.success ? parsed.data : null;
  if (response.ok && envelope?.code === 0 && result?.data) {
    return { ok: true, data: result.data.data };
  }
  const message =
    envelope?.error?.message ??
    (response.status === 401 ? '请先登录。' : `API 返回 ${response.status}`);
  const code = envelope?.error?.code ?? null;
  const requestId = envelope?.request_id ?? response.headers.get('x-request-id');
  return {
    ok: false,
    status: response.status,
    code,
    requestId,
    message: `HTTP ${response.status}${code ? ` · ${code}` : ''}: ${message}${requestId ? `（request_id: ${requestId}）` : ''}`,
  };
}
