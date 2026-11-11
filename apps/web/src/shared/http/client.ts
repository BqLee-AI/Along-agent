import { EnvelopeSchema } from '@along/contracts';
import type { Envelope } from '@along/contracts';
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

export async function readEnvelope(response: Response): Promise<unknown> {
  requireClientSession(response);
  let payload: Envelope;
  try {
    payload = EnvelopeSchema.parse(await response.json());
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
  return payload.data;
}
