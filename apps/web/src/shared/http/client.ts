import { EnvelopeSchema } from '@along/contracts';
import type { JsonResult } from './eden';
import { requireClientSession } from '../session/navigation';
export class ApiReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly requestId: string | null,
    message: string,
  ) {
    super(
      `HTTP ${status}${code ? ` · ${code}` : ''}: ${message}${requestId ? `（request_id: ${requestId}）` : ''}`,
    );
    this.name = 'ApiReadError';
  }
}

export function readEnvelope<T>(result: JsonResult<T>): Promise<T>;
/** SSE admission failures still arrive as a raw Response, not a JSON route call. */
export function readEnvelope(result: Response): Promise<unknown>;
export async function readEnvelope<T>(result: JsonResult<T> | Response): Promise<unknown> {
  const response = result instanceof Response ? result : result.response;
  requireClientSession(response);
  let payload;
  try {
    payload = EnvelopeSchema.parse(
      result instanceof Response
        ? await result.json()
        : result.error
          ? result.error.value
          : result.data,
    );
  } catch {
    throw new ApiReadError(
      response.status,
      null,
      response.headers.get('x-request-id'),
      '响应不符合公开读取合同。',
    );
  }
  if (!response.ok || payload.code !== 0) {
    const detail = payload.error;
    throw new ApiReadError(
      response.status,
      detail?.code ?? null,
      payload.request_id,
      detail?.message ?? `请求失败（${response.status}）`,
    );
  }
  if (result instanceof Response) return payload.data;
  if (!result.data)
    throw new ApiReadError(response.status, null, payload.request_id, '响应不符合公开读取合同。');
  return result.data.data;
}
