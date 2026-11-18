import type { ServerResponse } from 'node:http';
import { writeFiniteResponse } from './unread-upload.js';

async function pipeEventStream(response: Response, res: ServerResponse): Promise<void> {
  const reader = response.body?.getReader();
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.flushHeaders?.();
  if (!reader) {
    res.end();
    return;
  }
  const onClose = () => {
    void reader.cancel().catch(() => {});
  };
  res.once('close', onClose);
  if (res.destroyed) onClose();
  try {
    while (!res.destroyed && !res.writableEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        const { promise, resolve } = Promise.withResolvers<void>();
        const ready = () => {
          res.off('drain', ready);
          res.off('close', ready);
          resolve();
        };
        res.once('drain', ready);
        res.once('close', ready);
        if (res.destroyed) ready();
        await promise;
      }
    }
  } finally {
    res.off('close', onClose);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

export async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    await pipeEventStream(response, res);
    return;
  }
  const payload = await response.text();
  const headers: Record<string, string | string[]> = Object.fromEntries(response.headers.entries());
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  // The transport owns framing on connections marked for early close.
  if (res.shouldKeepAlive === false && res.getHeader('connection') === 'close') {
    delete headers['content-length'];
  }
  writeFiniteResponse(res, response.status, headers, payload);
}
