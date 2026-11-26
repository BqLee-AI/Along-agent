import { isIP } from 'node:net';
import type { ServerResponse } from 'node:http';
import { attachConnection } from '../http/transport/metadata.js';

// These headers are owned by the Cangjie listener and arrive over its private socket.
export function finiteRequest(request: Request): Request {
  const peer = request.headers.get('x-along-host-peer');
  const local = request.headers.get('x-along-host-local');
  const encrypted = request.headers.get('x-along-host-tls') === '1';
  const length = request.headers.get('x-along-host-body-length');
  for (const name of [
    'x-along-host-peer',
    'x-along-host-local',
    'x-along-host-tls',
    'x-along-host-body-length',
    'x-along-host-operation',
  ])
    request.headers.delete(name);
  if (length !== null) request.headers.set('content-length', length);
  attachConnection(request, {
    remoteAddress: peer && isIP(peer) ? peer : null,
    localAddress: local && isIP(local) ? local : null,
    encrypted,
  });
  return request;
}

export async function writeFiniteReply(result: Response, response: ServerResponse): Promise<void> {
  const body = Buffer.from(await result.arrayBuffer());
  if (response.destroyed) return;
  const headers: Record<string, string | string[]> = Object.fromEntries(result.headers);
  const cookies = result.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  headers['content-length'] = String(body.length);
  response.writeHead(result.status, headers).end(body);
}
