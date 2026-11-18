import type { IncomingMessage } from 'node:http';

function requestBody(req: IncomingMessage): ReadableStream<Uint8Array> {
  let cleanup = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer) => {
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 0) <= 0) req.pause();
      };
      const onEnd = () => {
        cleanup();
        controller.close();
      };
      const onInterrupted = () => {
        cleanup();
        controller.error(new Error('request interrupted'));
      };
      cleanup = () => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onInterrupted);
        req.off('close', onInterrupted);
      };
      req.pause();
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onInterrupted);
      req.once('close', onInterrupted);
    },
    pull() {
      req.resume();
    },
    cancel() {
      req.pause();
      cleanup();
    },
  });
}

export function toWebRequest(req: IncomingMessage, url: URL, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) headers.set(name, value);
  }
  const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers, signal };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = requestBody(req);
    init.duplex = 'half';
  }
  return new Request(url.href, init);
}
