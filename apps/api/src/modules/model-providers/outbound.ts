import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Conservative public-unicast allowlist; mapped, reserved and transition IPv6 are denied. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6 || address.includes('%') || address.includes('.')) return false;
  // Exclude non-global, documentation, protocol-assignment and transition ranges.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  const parts = canonical.split(':');
  const first = parseInt(parts[0] || '0', 16);
  const second = parseInt(parts[1] || '0', 16);
  return (
    first >= 0x2000 &&
    first < 0x3fff &&
    first !== 0x2002 &&
    !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
  );
}

// Only literal private or loopback targets may be explicitly permitted; DNS
// names, link-local addresses and metadata endpoints cannot enter this exception.
function isApprovedLocalOrigin(url: URL, address: string): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host !== address) return false;
  const family = isIP(address);
  let local = false;
  if (family === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    local = a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  } else if (family === 6) {
    const first = parseInt(address.split(':')[0] || '0', 16);
    local = address === '::1' || (first >= 0xfc00 && first <= 0xfdff);
  }
  if (!local) return false;
  return (process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS ?? '').split(',').some((entry) => {
    try {
      const allowed = new URL(entry.trim());
      return (
        allowed.origin === url.origin &&
        allowed.pathname === '/' &&
        !allowed.search &&
        !allowed.hash &&
        !allowed.username &&
        !allowed.password
      );
    } catch {
      return false;
    }
  });
}

// A deployment may explicitly trust fake-IP DNS for exact HTTPS origins.
// TLS still authenticates the original hostname; DNS answers are pinned below.
function isApprovedFakeDnsOrigin(url: URL, address: string): boolean {
  if (url.protocol !== 'https:' || isIP(url.hostname) !== 0 || isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  if (a !== 198 || (b !== 18 && b !== 19)) return false;
  return (process.env.MODEL_PROVIDER_ALLOWED_FAKE_DNS_ORIGINS ?? '')
    .split(',')
    .some((entry) => entry.trim() === url.origin);
}

export type OutboundFailure =
  | 'invalid_endpoint'
  | 'blocked_address'
  | 'timeout'
  | 'connection'
  | 'authentication'
  | 'unsupported'
  | 'incompatible';
export class OutboundError extends Error {
  constructor(public readonly category: OutboundFailure) {
    super(category);
  }
}
type OutboundTransport = {
  resolve: (hostname: string) => Promise<{ address: string; family: number }[]>;
  httpRequest: (
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
  httpsRequest: (
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
};

const productionTransport: OutboundTransport = {
  resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  httpRequest,
  httpsRequest,
};

/**
 * Fetch adapter for SDKs. Accepts standard string, URL or Request inputs and
 * RequestInit; URLs with credentials and all redirects are rejected. The
 * response and request bodies are streamed, and the signal remains effective
 * until the response body finishes or is cancelled.
 */
export async function outboundFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return outboundFetchForTest(input, init, productionTransport);
}

/** Test-only dependency seam; never select dependencies from external input. */
export async function outboundFetchForTest(
  input: string | URL | Request,
  init: RequestInit | undefined,
  transport: OutboundTransport,
): Promise<Response> {
  let request: Request;
  let url: URL;
  try {
    request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error();
  } catch {
    throw new OutboundError('invalid_endpoint');
  }

  const signal = request.signal;
  const abortError = () => new DOMException('The operation was aborted', 'AbortError');
  if (signal.aborted) throw abortError();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  // HTTP exposes credentials and prompts; only explicitly approved local targets may use it.
  if (url.protocol === 'http:' && !isApprovedLocalOrigin(url, hostname)) {
    throw new OutboundError('blocked_address');
  }
  const family = isIP(hostname);
  let records: { address: string; family: number }[];
  let abortLookup: (() => void) | undefined;
  try {
    const aborted = Promise.withResolvers<never>();
    abortLookup = () => aborted.reject(abortError());
    signal.addEventListener('abort', abortLookup, { once: true });
    if (signal.aborted) abortLookup();
    records = await Promise.race([
      family ? Promise.resolve([{ address: hostname, family }]) : transport.resolve(hostname),
      aborted.promise,
    ]);
  } catch {
    if (signal.aborted) throw abortError();
    throw new OutboundError('connection');
  } finally {
    if (abortLookup) signal.removeEventListener('abort', abortLookup);
  }
  if (
    !records.length ||
    records.some(
      (record) =>
        !isPublicAddress(record.address) &&
        !isApprovedLocalOrigin(url, record.address) &&
        !isApprovedFakeDnsOrigin(url, record.address),
    )
  ) {
    throw new OutboundError('blocked_address');
  }
  const destination = records[0]!;
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let responseEnded = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      } else if (!responseEnded && streamController) {
        responseEnded = true;
        streamController.error(error);
      }
    };
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      agent: false,
      autoSelectFamily: false,
      lookup: (_name, _options, callback) =>
        callback(null, destination.address, destination.family),
    };
    const req = (url.protocol === 'https:' ? transport.httpsRequest : transport.httpRequest)(
      url,
      options,
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          signal.removeEventListener('abort', abort);
          res.destroy();
          fail(new OutboundError('connection'));
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, value);
        }
        const noBody =
          request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
        const body = noBody
          ? null
          : new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
                res.on('data', (chunk: Buffer) => {
                  if (responseEnded) return;
                  controller.enqueue(chunk);
                  if ((controller.desiredSize ?? 0) <= 0) res.pause();
                });
                res.on('end', () => {
                  if (responseEnded) return;
                  responseEnded = true;
                  signal.removeEventListener('abort', abort);
                  controller.close();
                });
                res.on('error', () => {
                  signal.removeEventListener('abort', abort);
                  fail(signal.aborted ? abortError() : new OutboundError('connection'));
                });
                res.on('close', () => {
                  if (!responseEnded) {
                    signal.removeEventListener('abort', abort);
                    fail(signal.aborted ? abortError() : new OutboundError('connection'));
                  }
                });
              },
              pull() {
                res.resume();
              },
              cancel() {
                responseEnded = true;
                signal.removeEventListener('abort', abort);
                res.destroy();
                req.destroy();
              },
            });
        if (noBody) {
          responseEnded = true;
          signal.removeEventListener('abort', abort);
          res.on('error', () => {});
          res.resume();
        }
        try {
          const response = new Response(body, { status, statusText: res.statusMessage, headers });
          settled = true;
          resolve(response);
        } catch {
          res.destroy();
          fail(new OutboundError('connection'));
        }
      },
    );
    const abort = () => {
      fail(abortError());
      req.destroy();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    req.on('error', () => {
      signal.removeEventListener('abort', abort);
      fail(signal.aborted ? abortError() : new OutboundError('connection'));
    });
    if (!request.body) req.end();
    else {
      const reader = request.body.getReader();
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!req.write(value)) {
              const drain = Promise.withResolvers<void>();
              const cleanup = () => {
                req.off('drain', onDrain);
                req.off('error', onError);
                req.off('close', onError);
              };
              const onDrain = () => {
                cleanup();
                drain.resolve();
              };
              const onError = () => {
                cleanup();
                drain.reject();
              };
              req.once('drain', onDrain);
              req.once('error', onError);
              req.once('close', onError);
              await drain.promise;
            }
          }
          req.end();
        } catch {
          fail(signal.aborted ? abortError() : new OutboundError('connection'));
          req.destroy();
        } finally {
          reader.releaseLock();
        }
      })();
      req.on('close', () => {
        void reader.cancel().catch(() => {});
      });
    }
  }).catch((error: unknown) => {
    if (signal.aborted) throw abortError();
    if (error instanceof OutboundError) throw error;
    throw new OutboundError('connection');
  });
}

/** JSON calls use the same pinned transport as SDK calls. */
export async function outboundJson(
  baseUrl: string,
  path: string,
  apiKey: string | null,
  body?: unknown,
): Promise<unknown> {
  let url: URL;
  try {
    const base = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error();
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/${path}`;
    url = base;
  } catch {
    throw new OutboundError('invalid_endpoint');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const response = await outboundFetch(url, {
      signal: controller.signal,
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: payload,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new OutboundError(
        response.status === 401 || response.status === 403
          ? 'authentication'
          : response.status === 404 || response.status === 405 || response.status === 501
            ? 'unsupported'
            : 'connection',
      );
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1048576) {
          await reader.cancel();
          throw new OutboundError('incompatible');
        }
        chunks.push(value);
      }
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new OutboundError('incompatible');
    }
  } catch (error) {
    if (controller.signal.aborted) throw new OutboundError('timeout');
    if (error instanceof OutboundError) throw error;
    throw new OutboundError('connection');
  } finally {
    clearTimeout(timer);
  }
}
