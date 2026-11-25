import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import {
  HARNESS_MAX_FRAME_BYTES,
  HarnessRequestSchema,
  HarnessStartSchema,
  HarnessR3ContextStartSchema,
  type HarnessRequest,
  type HarnessR3ContextStart,
  type HarnessStart,
} from '@along/contracts';
import { ApplicationError } from '../../platform/errors.js';

export interface HarnessProcessServices {
  binaryPath: string;
  libraryPath?: string;
}

type EnqueueNativeFrame = () => undefined;
export type NativeHandoff = (enqueue: EnqueueNativeFrame) => Promise<void>;
export type NativeReplyHandoff = (
  request: HarnessRequest,
  result: unknown,
  enqueue: EnqueueNativeFrame,
) => Promise<void>;

export interface NativeHarnessOptions {
  services: HarnessProcessServices;
  start: HarnessStart | HarnessR3ContextStart;
  signal: AbortSignal;
  handleRequest: (request: HarnessRequest) => Promise<unknown>;
  guardStart?: NativeHandoff;
  guardReply?: NativeReplyHandoff;
  onExit?: () => void | Promise<void>;
  detachOnAbort?: boolean;
}

function protocolError(): ApplicationError {
  return new ApplicationError(502, 'HARNESS_PROTOCOL_ERROR', 'harness protocol rejected');
}

function encodeFrame(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > HARNESS_MAX_FRAME_BYTES)
    throw protocolError();
  return json;
}

/**
 * The compact subprocess has a separate, EOF-delimited input, not a Run frame.
 * A near-limit prompt grows when escaped, and an oversized provider response
 * can still contain a valid summary. The ordinary Run frame cap stays intact.
 */
export async function callNativeCompact(
  services: HarnessProcessServices,
  operation: 'assemble' | 'interpret',
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  // stdx JSON does not represent lone UTF-16 surrogates. Preserve them as
  // escaped private-use pairs on this internal wire, including a real marker.
  const depths = new WeakMap<object, number>();
  const json = JSON.stringify(input, function (this: object, _key, value: unknown) {
    // Only the compact contract has to survive transport: no valid field
    // contains a container past this depth. Original provider sizes are
    // accounted before this projection, including values outside the contract.
    if (operation === 'interpret' && value && typeof value === 'object') {
      const depth = (depths.get(this) ?? -1) + 1;
      if (depth > 5) return null;
      depths.set(value, depth);
    }
    // The only accepted numeric values are safe integers. Preserve invalid
    // numeric types without feeding out-of-range values into stdx.
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
    return value;
  }).replace(/\\(?:["\\/bfnrt]|u[\da-f]{4})|\ue000/gi, (token) => {
    if (token === '\ue000') return '\ue000\ue000';
    const unit = token.length === 6 ? Number.parseInt(token.slice(2), 16) : 0;
    return unit >= 0xd800 && unit <= 0xdfff
      ? `\ue000${String.fromCharCode(0xe100 + unit - 0xd800)}`
      : token;
  });
  const { child, state, completion, terminate, dispose } = spawnHarness(services, [
    `compact-${operation}/1`,
  ]);
  signal.addEventListener('abort', terminate, { once: true });
  try {
    signal.throwIfAborted();
    child.stdin.end(json, 'utf8');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of child.stdout) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      // Assembly's estimated raw data is <= 1 MiB with up to two levels of
      // escaping. Interpretation emits only bounded summary/coverage/candidates.
      if (bytes > 8 * HARNESS_MAX_FRAME_BYTES) throw protocolError();
      chunks.push(buffer);
    }
    const exit = await completion;
    signal.throwIfAborted();
    assertHarnessExit(state, exit);
    try {
      const reply = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
      if (reply.indexOf('\n') !== reply.length - 1 || !reply.endsWith('\n')) throw protocolError();
      return JSON.parse(reply, (_key, value: unknown) =>
        typeof value === 'string'
          ? value.replace(/\ue000([\ue000\ue100-\ue8ff])/g, (_pair, unit: string) =>
              unit === '\ue000' ? unit : String.fromCharCode(unit.charCodeAt(0) - 0xe100 + 0xd800),
            )
          : value,
      ) as unknown;
    } catch {
      throw protocolError();
    }
  } finally {
    signal.removeEventListener('abort', terminate);
    await dispose();
  }
}

function spawnHarness(
  services: HarnessProcessServices,
  args: string[],
  onExit?: NativeHarnessOptions['onExit'],
) {
  const child = spawn(services.binaryPath, args, {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      ...(services.libraryPath ? { LD_LIBRARY_PATH: services.libraryPath } : {}),
    },
  });
  const state = { spawnFailed: false, transportFailed: false, exited: false };
  let closed = false;
  let killTimer: NodeJS.Timeout | undefined;
  // Exit can precede stdout drainage while a provider request is in flight.
  child.once('exit', () => {
    state.exited = true;
    void onExit?.();
  });
  const { promise: completion, resolve } = Promise.withResolvers<{
    code: number | null;
    signal: string | null;
  }>();
  child.once('error', () => {
    state.spawnFailed = true;
  });
  child.once('close', (code, exitSignal) => {
    closed = true;
    void onExit?.();
    resolve({ code, signal: exitSignal });
  });
  const terminate = () => {
    if (closed) return;
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => {
      if (!closed) child.kill('SIGKILL');
    }, 1000);
    killTimer.unref();
  };
  const pipeFailed = () => {
    state.transportFailed = true;
    terminate();
  };
  child.stdin.on('error', pipeFailed);
  child.stdout.on('error', pipeFailed);
  child.stderr.resume();
  return {
    child,
    state,
    completion,
    terminate,
    async dispose() {
      terminate();
      await completion;
      clearTimeout(killTimer);
    },
  };
}

function assertHarnessExit(
  state: { spawnFailed: boolean; transportFailed: boolean },
  exit: { code: number | null; signal: string | null },
): void {
  if (state.spawnFailed)
    throw new ApplicationError(503, 'HARNESS_UNAVAILABLE', 'harness unavailable');
  if (state.transportFailed || exit.code !== 0 || exit.signal !== null)
    throw new ApplicationError(502, 'HARNESS_EXITED', 'harness process exited unexpectedly');
}

// Only the synchronous pipe enqueue is under authority; drain outside the transaction.
async function writeLine(
  stream: Writable,
  json: string,
  signal: AbortSignal,
  guard?: NativeHandoff,
): Promise<boolean> {
  if (signal.aborted) return false;
  let flushed: Promise<void> | undefined;
  const enqueue = () => {
    if (flushed) throw protocolError();
    if (!signal.aborted) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      flushed = promise;
      stream.write(`${json}\n`, (error) => (error ? reject(protocolError()) : resolve()));
      void flushed.catch(() => {});
    }
    return undefined;
  };
  if (guard) await guard(enqueue);
  else enqueue();
  if (signal.aborted && !flushed) return false;
  if (!flushed) throw protocolError();
  await flushed;
  return !signal.aborted;
}

/** Transport only. The caller owns qualification and all durable Run decisions. */
export async function runNativeHarness(options: NativeHarnessOptions): Promise<void> {
  const { services, signal, handleRequest, guardStart, guardReply } = options;
  if (signal.aborted) return;
  const initialJson = JSON.stringify(options.start);
  if (Buffer.byteLength(initialJson, 'utf8') > HARNESS_MAX_FRAME_BYTES) {
    if (options.start.protocol === 'harness/v8')
      throw new ApplicationError(
        422,
        'HARNESS_CONTEXT_LIMIT',
        'harness context exceeds safe capacity',
      );
    throw protocolError();
  }
  const parsedStart =
    options.start.protocol === 'harness/v8'
      ? HarnessR3ContextStartSchema.safeParse(options.start)
      : HarnessStartSchema.safeParse(options.start);
  if (!parsedStart.success) throw protocolError();
  const startJson = encodeFrame(parsedStart.data);
  const { child, state, completion, terminate, dispose } = spawnHarness(
    services,
    [],
    options.onExit,
  );
  const abort = () => {
    if (!child.stdin.destroyed && child.stdin.writable) {
      child.stdin.write(
        `${JSON.stringify({ protocol: parsedStart.data.protocol, type: 'cancel', reason: 'run cancelled' })}\n`,
      );
    }
    terminate();
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const frame = Buffer.allocUnsafe(HARNESS_MAX_FRAME_BYTES);
  let frameBytes = 0;
  let terminal = false;
  const measureOnly =
    parsedStart.data.protocol === 'harness/v8' && parsedStart.data.mode === 'measure_only';
  const seenReferences = new Set<string>();
  try {
    if (!(await writeLine(child.stdin, startJson, signal, guardStart))) return;
    for await (const chunk of child.stdout) {
      const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset);
        const end = newline === -1 ? bytes.length : newline;
        const count = end - offset;
        if (frameBytes + count > HARNESS_MAX_FRAME_BYTES) throw protocolError();
        bytes.copy(frame, frameBytes, offset, end);
        frameBytes += count;
        offset = newline === -1 ? bytes.length : newline + 1;
        if (newline === -1) continue;
        if (terminal || frameBytes === 0) throw protocolError();
        let value: unknown;
        try {
          value = JSON.parse(decoder.decode(frame.subarray(0, frameBytes)));
        } catch {
          throw protocolError();
        }
        frameBytes = 0;
        const parsed = HarnessRequestSchema.safeParse(value);
        if (!parsed.success) {
          const fields = parsed.error.issues
            .slice(0, 4)
            .map((issue) => `${issue.path.join('.')}:${issue.code}`)
            .join(', ');
          throw new ApplicationError(
            502,
            'HARNESS_PROTOCOL_ERROR',
            `harness frame schema rejected (${fields})`,
          );
        }
        if (seenReferences.has(parsed.data.request_ref)) throw protocolError();
        const request = parsed.data;
        if (measureOnly !== (request.type === 'context_preview')) throw protocolError();
        if (request.protocol !== parsedStart.data.protocol) throw protocolError();
        seenReferences.add(request.request_ref);
        let reply: unknown;
        let result: unknown;
        let succeeded = false;
        try {
          if (options.detachOnAbort) {
            signal.throwIfAborted();
            const aborted = Promise.withResolvers<never>();
            const rejectOnAbort = () => aborted.reject(new Error('harness attempt aborted'));
            signal.addEventListener('abort', rejectOnAbort, { once: true });
            try {
              if (signal.aborted) rejectOnAbort();
              result = await Promise.race([handleRequest(request), aborted.promise]);
            } finally {
              signal.removeEventListener('abort', rejectOnAbort);
            }
          } else {
            result = await handleRequest(request);
          }
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
          reply = {
            protocol: parsedStart.data.protocol,
            type: 'reply',
            reply_to: request.request_ref,
            value: result,
          };
          succeeded = true;
          terminal =
            (measureOnly && request.type === 'context_preview') ||
            request.type === 'suspend' ||
            (request.type === 'pause_point' &&
              typeof result === 'object' &&
              result !== null &&
              'paused' in result &&
              result.paused === true) ||
            request.type === 'finish' ||
            (request.type === 'finish_goal' &&
              typeof result === 'object' &&
              result !== null &&
              'accepted' in result &&
              result.accepted === true);
        } catch (error) {
          if (!(error instanceof ApplicationError)) throw error;
          reply = {
            protocol: parsedStart.data.protocol,
            type: 'reply',
            reply_to: request.request_ref,
            error: { code: error.errorCode, message: 'harness request rejected' },
          };
        }
        if (signal.aborted) break;
        const written = await writeLine(
          child.stdin,
          encodeFrame(reply),
          signal,
          succeeded && guardReply ? (enqueue) => guardReply(request, result, enqueue) : undefined,
        );
        if (!written) break;
        if (terminal) child.stdin.end();
      }
      if (signal.aborted) break;
    }
    if (signal.aborted) return;
    if (frameBytes !== 0)
      throw new ApplicationError(
        502,
        'HARNESS_PROTOCOL_ERROR',
        'harness ended with an incomplete frame',
      );
    if (!terminal)
      throw new ApplicationError(
        502,
        'HARNESS_PROTOCOL_ERROR',
        'harness ended without terminal control',
      );
    assertHarnessExit(state, await completion);
  } catch (error) {
    if (signal.aborted) return;
    if (error instanceof ApplicationError && error.errorCode === 'FORBIDDEN') throw error;
    if (state.spawnFailed)
      throw new ApplicationError(503, 'HARNESS_UNAVAILABLE', 'harness unavailable');
    if (state.transportFailed || state.exited)
      throw new ApplicationError(502, 'HARNESS_EXITED', 'harness process exited unexpectedly');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    await dispose();
  }
}
