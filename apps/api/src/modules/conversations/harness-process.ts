import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import {
  HARNESS_MAX_FRAME_BYTES,
  HARNESS_PROTOCOL_VERSION,
  HarnessRequestSchema,
  HarnessStartSchema,
  type ContextPolicy,
  type HarnessContextMeasurement,
  type HarnessModelStep,
  type HarnessRequest,
  type HarnessStart,
  type HarnessTool,
} from '@along/contracts';
import { HttpError } from '../../http/errors.js';

export interface HarnessServices {
  binaryPath: string;
  libraryPath?: string;
  maxIterations: number;
  maxTokens: number;
  contextPolicy: ContextPolicy;
  measure?: (
    request: Extract<HarnessRequest, { type: 'measure_context' }>,
    tools: readonly HarnessTool[],
    policy: ContextPolicy,
  ) => HarnessContextMeasurement;
  model: (
    request: Extract<HarnessRequest, { type: 'model' }>,
    tools: readonly HarnessTool[],
    signal: AbortSignal,
  ) => AsyncGenerator<HarnessModelStep, void, unknown>;
}

export interface NativeHarnessOptions {
  services: HarnessServices;
  start: HarnessStart;
  signal: AbortSignal;
  handleRequest: (request: HarnessRequest) => Promise<unknown>;
  onExit?: () => void | Promise<void>;
}

function protocolError(): HttpError {
  return new HttpError(502, 502, 'HARNESS_PROTOCOL_ERROR', 'harness protocol rejected');
}

async function writeFrame(stream: Writable, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > HARNESS_MAX_FRAME_BYTES) {
    throw protocolError();
  }
  await writeLine(stream, json);
}

async function writeLine(stream: Writable, json: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(`${json}\n`, (error) => (error ? reject(protocolError()) : resolve()));
  });
}

/** Transport only. The caller owns qualification and all durable Run decisions. */
export async function runNativeHarness(options: NativeHarnessOptions): Promise<void> {
  const { services, signal, handleRequest } = options;
  if (signal.aborted) return;
  const parsedStart = HarnessStartSchema.safeParse(options.start);
  if (!parsedStart.success) throw protocolError();
  const startJson = JSON.stringify(parsedStart.data);
  if (Buffer.byteLength(startJson, 'utf8') > HARNESS_MAX_FRAME_BYTES) throw protocolError();
  const child = spawn(services.binaryPath, [], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      ...(services.libraryPath ? { LD_LIBRARY_PATH: services.libraryPath } : {}),
    },
  });
  let spawnFailed = false;
  let transportFailed = false;
  let closed = false;
  let exited = false;
  let killTimer: NodeJS.Timeout | undefined;
  // exit precedes stdio close: abort a provider read even while the request
  // handler is waiting and stdout has not yet been drained to EOF.
  child.once('exit', () => {
    exited = true;
    void options.onExit?.();
  });
  const completion = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('error', () => {
      spawnFailed = true;
    });
    child.once('close', (code, exitSignal) => {
      closed = true;
      void options.onExit?.();
      resolve({ code, signal: exitSignal });
    });
  });
  const terminate = () => {
    if (closed) return;
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => {
      if (!closed) child.kill('SIGKILL');
    }, 1000);
    killTimer.unref();
  };
  child.stdin.on('error', () => {
    transportFailed = true;
    terminate();
  });
  child.stdout.on('error', () => {
    transportFailed = true;
    terminate();
  });
  // Drain without retaining or exposing raw provider/context text on stderr.
  child.stderr.resume();
  const abort = () => {
    if (!child.stdin.destroyed && child.stdin.writable) {
      child.stdin.write(
        `${JSON.stringify({ protocol: HARNESS_PROTOCOL_VERSION, type: 'cancel', reason: 'run cancelled' })}\n`,
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
  const seenReferences = new Set<string>();
  try {
    await writeLine(child.stdin, startJson);
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
        if (!parsed.success || seenReferences.has(parsed.data.request_ref)) throw protocolError();
        const request = parsed.data;
        seenReferences.add(request.request_ref);
        let reply: unknown;
        try {
          const result = await handleRequest(request);
          if (result === undefined) throw protocolError();
          reply = {
            protocol: HARNESS_PROTOCOL_VERSION,
            type: 'reply',
            reply_to: request.request_ref,
            value: result,
          };
          terminal = request.type === 'suspend' || request.type === 'finish';
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          reply = {
            protocol: HARNESS_PROTOCOL_VERSION,
            type: 'reply',
            reply_to: request.request_ref,
            error: { code: error.errorCode, message: 'harness request rejected' },
          };
        }
        if (signal.aborted) break;
        await writeFrame(child.stdin, reply);
        if (terminal) child.stdin.end();
      }
      if (signal.aborted) break;
    }
    if (signal.aborted) return;
    if (frameBytes !== 0 || !terminal) throw protocolError();
    const exit = await completion;
    if (spawnFailed) throw new HttpError(503, 503, 'HARNESS_UNAVAILABLE', 'harness unavailable');
    if (transportFailed || exit.code !== 0 || exit.signal !== null) {
      throw new HttpError(502, 502, 'HARNESS_EXITED', 'harness process exited unexpectedly');
    }
  } catch (error) {
    if (signal.aborted) return;
    if (spawnFailed) throw new HttpError(503, 503, 'HARNESS_UNAVAILABLE', 'harness unavailable');
    if (transportFailed || exited)
      throw new HttpError(502, 502, 'HARNESS_EXITED', 'harness process exited unexpectedly');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!closed) terminate();
    await completion;
    clearTimeout(killTimer);
  }
}
