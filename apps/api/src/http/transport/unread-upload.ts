import type { IncomingMessage, ServerResponse } from 'node:http';

export function closeUnreadRequest(req: IncomingMessage, res: ServerResponse): void {
  if (!req.socket || req.readableEnded) return;
  req.pause();
  res.shouldKeepAlive = false;
  res.setHeader('connection', 'close');
}

export function writeFiniteResponse(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | string[]>,
  payload: string,
): void {
  const closingUpload = res.shouldKeepAlive === false && res.getHeader('connection') === 'close';
  res.writeHead(status, {
    ...(closingUpload ? { 'content-length': String(Buffer.byteLength(payload)) } : {}),
    ...headers,
  });
  if (!closingUpload) {
    res.end(payload);
    return;
  }
  // Frame the finite response before closing with upload bytes still in flight.
  res.write(payload);
  const timer = setTimeout(() => res.end(), 250);
  res.once('close', () => clearTimeout(timer));
}
