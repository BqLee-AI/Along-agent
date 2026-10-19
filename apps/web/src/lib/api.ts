// Server-side API access. The browser uses the same-origin proxy at
// /api/v1/*; server components forward the incoming session cookie.
import { cookies } from "next/headers";

const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:3000";

interface Envelope<T> {
  code: number;
  data: T;
  msg: string;
  error: { code: string; message: string } | null;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const cookie = (await cookies()).toString();
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: cookie ? { cookie } : {},
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, message: "无法连接 API，请确认服务已启动。" };
  }
  let envelope: Envelope<T> | null = null;
  try {
    envelope = (await response.json()) as Envelope<T>;
  } catch {
    envelope = null;
  }
  if (response.ok && envelope && envelope.code === 0) {
    return { ok: true, data: envelope.data };
  }
  const message =
    envelope?.error?.message ??
    (response.status === 401 ? "请先登录。" : `API 返回 ${response.status}`);
  return { ok: false, status: response.status, message };
}
