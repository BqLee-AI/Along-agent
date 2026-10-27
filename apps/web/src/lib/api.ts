// Server-side API access. The browser uses the same-origin proxy at
// /api/v1/*; server components forward the incoming session cookie.
import { cookies } from 'next/headers';
import { EnvelopeSchema, type Envelope } from '@along/contracts';
import { redirect } from 'next/navigation';
import { protectedLoginHref } from './account-navigation';

const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

export async function apiGet<T>(path: string, returnTo?: string): Promise<ApiResult<T>> {
  const cookie = (await cookies()).toString();
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: cookie ? { cookie } : {},
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, message: '无法连接 API，请确认服务已启动。' };
  }
  if (returnTo !== undefined) {
    const login = protectedLoginHref(response.status, returnTo);
    if (login) redirect(login);
  }
  let envelope: Envelope | null = null;
  try {
    envelope = EnvelopeSchema.parse(await response.json());
  } catch {
    envelope = null;
  }
  if (response.ok && envelope && envelope.code === 0) {
    return { ok: true, data: envelope.data as T };
  }
  const message =
    envelope?.error?.message ??
    (response.status === 401 ? '请先登录。' : `API 返回 ${response.status}`);
  return { ok: false, status: response.status, message };
}
