import {
  HARNESS_MAX_FRAME_BYTES,
  HarnessR3ContextStartSchema,
  HarnessRequestSchema,
  HarnessStartSchema,
  type HarnessRequest,
} from '@along/contracts';
import type { NativeHandoff, NativeHarnessOptions } from '../agent/harness/harness-process.js';
import { ApplicationError } from '../platform/errors.js';

function protocolError(message = 'harness protocol rejected'): ApplicationError {
  return new ApplicationError(502, 'HARNESS_PROTOCOL_ERROR', message);
}

function encodeFrame(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > HARNESS_MAX_FRAME_BYTES)
    throw protocolError();
  return json;
}

function decodeRequest(raw: string): HarnessRequest {
  if (!raw || raw.includes('\n') || Buffer.byteLength(raw, 'utf8') > HARNESS_MAX_FRAME_BYTES)
    throw protocolError();
  let value: unknown;
  try {
    value = JSON.parse(raw.startsWith('\uFEFF') ? raw.slice(1) : raw);
  } catch {
    throw protocolError();
  }
  const parsed = HarnessRequestSchema.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join('.')}:${issue.code}`)
      .join(', ');
    throw protocolError(`harness frame schema rejected (${fields})`);
  }
  return parsed.data;
}

/** Frames for one native attempt; the caller owns its lifecycle and durable decisions. */
export function createHostHarnessExchange(options: NativeHarnessOptions) {
  const { signal, handleRequest, guardStart, guardReply } = options;
  const { protocol } = options.start;
  const measureOnly =
    options.start.protocol === 'harness/v8' && options.start.mode === 'measure_only';
  const seenReferences = new Set<string>();
  let phase: 'new' | 'busy' | 'ready' | 'terminal' | 'closed' = 'new';

  async function handoff(
    frame: string,
    nextPhase: 'ready' | 'terminal',
    guard?: NativeHandoff,
  ): Promise<string> {
    signal.throwIfAborted();
    let enqueued = false;
    const enqueue = () => {
      if (enqueued) throw protocolError();
      if (!signal.aborted && phase === 'busy') enqueued = true;
      return undefined;
    };
    if (guard) await guard(enqueue);
    else enqueue();
    signal.throwIfAborted();
    if (!enqueued || phase !== 'busy') throw protocolError();
    phase = nextPhase;
    return frame;
  }

  async function start(): Promise<string> {
    if (phase !== 'new') throw protocolError();
    phase = 'busy';
    try {
      signal.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(options.start), 'utf8') > HARNESS_MAX_FRAME_BYTES) {
        if (protocol === 'harness/v8')
          throw new ApplicationError(
            422,
            'HARNESS_CONTEXT_LIMIT',
            'harness context exceeds safe capacity',
          );
        throw protocolError();
      }
      const parsed =
        protocol === 'harness/v8'
          ? HarnessR3ContextStartSchema.safeParse(options.start)
          : HarnessStartSchema.safeParse(options.start);
      if (!parsed.success) throw protocolError();
      return await handoff(encodeFrame(parsed.data), 'ready', guardStart);
    } catch (error) {
      phase = 'closed';
      throw error;
    }
  }

  async function dispatch(request: HarnessRequest): Promise<unknown> {
    if (!options.detachOnAbort) return handleRequest(request);
    signal.throwIfAborted();
    const aborted = Promise.withResolvers<never>();
    const rejectOnAbort = () => aborted.reject(new Error('harness attempt aborted'));
    signal.addEventListener('abort', rejectOnAbort, { once: true });
    try {
      return await Promise.race([handleRequest(request), aborted.promise]);
    } finally {
      signal.removeEventListener('abort', rejectOnAbort);
    }
  }

  async function exchange(raw: string): Promise<string> {
    if (phase !== 'ready') throw protocolError();
    phase = 'busy';
    try {
      signal.throwIfAborted();
      const request = decodeRequest(raw);
      if (
        request.protocol !== protocol ||
        measureOnly !== (request.type === 'context_preview') ||
        seenReferences.has(request.request_ref)
      )
        throw protocolError();
      seenReferences.add(request.request_ref);

      let result: unknown;
      let rejection: ApplicationError | undefined;
      try {
        result = await dispatch(request);
        if (result === undefined) throw protocolError();
        if (
          measureOnly &&
          (typeof result !== 'object' ||
            result === null ||
            !('accepted' in result) ||
            result.accepted !== true ||
            Object.keys(result).length !== 1)
        )
          throw protocolError();
      } catch (error) {
        if (!(error instanceof ApplicationError)) throw error;
        rejection = error;
      }
      signal.throwIfAborted();

      const terminal =
        !rejection &&
        (request.type === 'context_preview' ||
          request.type === 'suspend' ||
          request.type === 'finish' ||
          (typeof result === 'object' &&
            result !== null &&
            ((request.type === 'pause_point' && 'paused' in result && result.paused === true) ||
              (request.type === 'finish_goal' &&
                'accepted' in result &&
                result.accepted === true))));
      return await handoff(
        encodeFrame({
          protocol,
          type: 'reply',
          reply_to: request.request_ref,
          ...(rejection
            ? { error: { code: rejection.errorCode, message: 'harness request rejected' } }
            : { value: result }),
        }),
        terminal ? 'terminal' : 'ready',
        !rejection && guardReply ? (enqueue) => guardReply(request, result, enqueue) : undefined,
      );
    } catch (error) {
      phase = 'closed';
      throw error;
    }
  }

  function finish(): void {
    const terminal = phase === 'terminal';
    phase = 'closed';
    if (!signal.aborted && !terminal) throw protocolError('harness ended without terminal control');
  }

  return { start, exchange, finish };
}
