export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; code: string | null; requestId: string | null };
