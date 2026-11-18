import { isIP } from 'node:net';
import { z } from 'zod';
import { normalizeVector } from './vector.js';

type EncoderFetch = (url: string, init: RequestInit) => Promise<Response>;

const responseSchema = z
  .object({
    binding_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    token_count: z.number().int().min(1).max(256),
    dimension: z.literal(512),
    vector: z.array(z.number().finite()).length(512),
  })
  .strict();
// Across all Runtime instances in one API process; never a per-Run semaphore.
let inFlight = 0;
export class EncoderRefusal extends Error {}

export function validateEncoderUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const privateIpv4 =
    isIP(host) === 4 && /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
  const privateHostname =
    /^[a-z][a-z0-9-]*$/i.test(host) || host.endsWith('.internal') || host.endsWith('.localhost');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '') ||
    !(privateIpv4 || privateHostname || host === '::1')
  )
    throw new Error('ENCODER_URL_MUST_BE_PRIVATE_ORIGIN');
  return `${url.origin}/encode`;
}

export type EncoderDeadline = (callback: () => void, delayMs: number) => () => void;
export async function requestEncoding(input: {
  text: string;
  binding: string;
  url: string;
  signal: AbortSignal;
  deadlineMs: number;
  fetch: EncoderFetch;
  scheduleDeadline?: EncoderDeadline;
}): Promise<{ vector: Float64Array; tokenCount: number }> {
  input.signal.throwIfAborted();
  if (input.deadlineMs <= 0) throw new EncoderRefusal('ENCODING_DEADLINE');
  if (inFlight >= 2) throw new EncoderRefusal('ENCODING_CAPACITY');
  inFlight++;
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener('abort', abort, { once: true });
  const scheduleDeadline: EncoderDeadline =
    input.scheduleDeadline ??
    ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  let cancelDeadline: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    cancelDeadline = scheduleDeadline(() => {
      controller.abort(new EncoderRefusal('ENCODING_DEADLINE'));
      reject(new EncoderRefusal('ENCODING_DEADLINE'));
    }, input.deadlineMs);
  });
  // The underlying operation owns capacity until it really settles, even if a
  // non-cooperative transport ignores abort. Sidecar separately holds CPU slots.
  const operation = (async () => {
    try {
      const response = await input.fetch(input.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          binding_sha256: input.binding,
          text: input.text,
          max_tokens: 256,
          truncate: false,
        }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new EncoderRefusal(`ENCODING_HTTP_${response.status}`);
      }
      if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        throw new EncoderRefusal('ENCODING_CONTENT_TYPE');
      }
      if (!response.body) throw new EncoderRefusal('ENCODING_EMPTY_BODY');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 64 * 1024) {
            await reader.cancel();
            throw new EncoderRefusal('ENCODING_RESPONSE_CAPACITY');
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const parsed = responseSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      );
      if (parsed.binding_sha256 !== input.binding)
        throw new EncoderRefusal('ENCODING_BINDING_MISMATCH');
      return { vector: normalizeVector(parsed.vector), tokenCount: parsed.token_count };
    } finally {
      inFlight--;
    }
  })();
  const canceled = new Promise<never>((_, reject) => {
    if (input.signal.aborted) reject(input.signal.reason);
    else
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
  });
  try {
    return await Promise.race([operation, deadline, canceled]);
  } catch (error) {
    input.signal.throwIfAborted();
    if (error instanceof EncoderRefusal) throw error;
    throw new EncoderRefusal('ENCODING_INVALID_OR_UNAVAILABLE', { cause: error });
  } finally {
    cancelDeadline?.();
    input.signal.removeEventListener('abort', abort);
  }
}
