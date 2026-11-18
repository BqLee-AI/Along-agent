import { treaty, type Treaty } from '@elysia/eden';
import type { App } from '@along/api/client-type';

/** Eden otherwise turns network/abort failures into a response-less 503 result. */
export function throwTransportError(error: { value: unknown }): false {
  if (error.value instanceof Error) throw error.value;
  return false;
}

/** Keep malformed JSON at the envelope validation boundary, with its HTTP identity. */
export async function decodeJsonResponse(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') return;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {};
  }
  // Successful JSON is already decoded. For HTTP errors Eden must construct its
  // typed error result itself; it reads the original response, not this clone.
  return response.ok ? (payload ?? {}) : undefined;
}

type BrowserRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type ApiClient = ReturnType<typeof treaty<App>>;

/** Only the browser's same-origin Next proxy is reachable from this client. */
export function createBrowserApi(request: BrowserRequest = (...args) => fetch(...args)): ApiClient {
  return treaty<App>('http://same-origin.internal', {
    parseDate: false,
    throwHttpError: throwTransportError,
    onResponse: decodeJsonResponse,
    fetch: { cache: 'no-store', credentials: 'same-origin' },
    // Eden types fetcher as the global fetch, including Bun's extra properties.
    fetcher: new Proxy(fetch, {
      apply(_target, _thisArg, [input, init]: Parameters<BrowserRequest>) {
        const url = new URL(String(input));
        return request(`${url.pathname}${url.search}`, init);
      },
    }),
  });
}

export const api: ApiClient = createBrowserApi();
export type ApiError = Treaty.Error<ApiClient['api']['v1']['me']['get']>;
export type JsonResult<T> = {
  data: { data: T } | null;
  error: ApiError | null;
  response: Response;
};
export type JsonCall<T> = (client: ApiClient) => Promise<JsonResult<T>>;

export function writeOptions(csrf: string | null, signal?: AbortSignal, key?: string) {
  return {
    headers: {
      ...(csrf !== null ? { 'x-csrf-token': csrf } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    fetch: { signal },
  };
}
