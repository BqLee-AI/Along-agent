// Same-origin proxy to the API. Keeps cookies and CSRF headers intact and
// streams responses (SSE included) without buffering.
import type { NextRequest } from 'next/server';
import { EnvelopeSchema } from '@along/contracts';

const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000';
const FORWARD_REQUEST = [
  'cookie',
  'authorization',
  'content-type',
  'x-csrf-token',
  'idempotency-key',
  'x-request-id',
  'accept',
  'origin',
];
const FORWARD_RESPONSE = [
  'content-type',
  'cache-control',
  'x-request-id',
  'set-cookie',
  'retry-after',
];

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

async function proxy(req: NextRequest, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const target = new URL(`/api/${path.join('/')}`, API_BASE);
  target.search = new URL(req.url).search;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Next's Node adapter signals a premature response close, not normal EOF.
  // Also handle downstream stream cancellation (including reader.cancel()).
  const controller = new AbortController();
  const abort = () => {
    controller.abort(req.signal.reason);
  };
  req.signal.addEventListener('abort', abort, { once: true });
  if (req.signal.aborted) abort();
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers,
    cache: 'no-store',
    redirect: 'manual',
    signal: controller.signal,
  };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    init.body = req.body;
    init.duplex = 'half';
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    req.signal.removeEventListener('abort', abort);
    if (controller.signal.aborted) throw controller.signal.reason;
    const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
    return Response.json(
      EnvelopeSchema.parse({
        code: 502,
        data: null,
        msg: 'api unreachable',
        error: { code: 'BAD_GATEWAY', message: 'API 不可达', request_id: requestId },
        request_id: requestId,
      }),
      { status: 502, headers: { 'x-request-id': requestId, 'cache-control': 'no-store' } },
    );
  }

  const responseHeaders = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length > 0) {
    responseHeaders.delete('set-cookie');
    for (const cookie of cookies) responseHeaders.append('set-cookie', cookie);
  }
  if (path[0] === 'v1' && (path[1] === 'auth' || path[1] === 'me')) {
    responseHeaders.set('cache-control', 'no-store');
  }
  if (!upstream.body) {
    req.signal.removeEventListener('abort', abort);
    return new Response(null, { status: upstream.status, headers: responseHeaders });
  }
  const reader = upstream.body.getReader();
  if (controller.signal.aborted) await reader.cancel(controller.signal.reason);
  const body = new ReadableStream<Uint8Array>({
    async pull(downstream) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          req.signal.removeEventListener('abort', abort);
          downstream.close();
        } else {
          downstream.enqueue(chunk.value);
        }
      } catch (error) {
        req.signal.removeEventListener('abort', abort);
        controller.abort(error);
        await reader.cancel(error).catch(() => undefined);
        downstream.error(error);
      }
    },
    async cancel(reason) {
      req.signal.removeEventListener('abort', abort);
      controller.abort(reason);
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, { status: upstream.status, headers: responseHeaders });
}

export const dynamic = 'force-dynamic';

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
