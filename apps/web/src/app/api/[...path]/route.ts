// Same-origin proxy to the API. Keeps cookies and CSRF headers intact and
// streams responses (SSE included) without buffering.
import type { NextRequest } from 'next/server';

const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000';
const FORWARD_REQUEST = [
  'cookie',
  'authorization',
  'content-type',
  'x-csrf-token',
  'idempotency-key',
  'x-request-id',
  'accept',
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
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers,
    cache: 'no-store',
    redirect: 'manual',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    init.body = req.body;
    init.duplex = 'half';
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    return Response.json(
      {
        code: 502,
        data: null,
        msg: 'api unreachable',
        error: { code: 'BAD_GATEWAY', message: 'API 不可达' },
      },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const dynamic = 'force-dynamic';

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
