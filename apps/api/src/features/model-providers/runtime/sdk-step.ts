import { HARNESS_MAX_FRAME_BYTES, HarnessModelReplySchema } from '@along/contracts';
import type { ModelStepTransport } from './model-contract.js';
import {
  serializeSdkRequest,
  createSdkModel,
  sdkCallOptions,
  type SdkFetch,
} from './sdk-context.js';
import { ApplicationError } from '../../../platform/errors.js';
import { OutboundError } from '../outbound/outbound.js';
import {
  ModelProtocolError,
  contextLimit,
  modelProtocolError,
  normalizeResponse,
  type UsageState,
} from './model-stream.js';

export interface SdkStepConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  diagnostic?: { runId: string; attemptId: string; operation: 'compact' | 'model' };
}

/** Streaming network executor; rechecks dispatch authority after any awaited destination work. */
export type SdkStepNetwork = (
  ...args: [...Parameters<SdkFetch>, authorizeDispatch?: () => Promise<void>]
) => Promise<Response>;

class ModelUnavailableError extends ApplicationError {
  constructor(
    readonly reason: string,
    readonly status?: number,
  ) {
    super(503, 'HARNESS_UNAVAILABLE', 'harness model transport unavailable');
  }
}

function outboundFailure(error: unknown): ModelUnavailableError | undefined {
  if (
    error instanceof OutboundError &&
    [
      'invalid_endpoint',
      'blocked_address',
      'timeout',
      'connection',
      'authentication',
      'unsupported',
      'incompatible',
    ].includes(error.category)
  ) {
    return new ModelUnavailableError(`outbound_${error.category}`);
  }
  return undefined;
}

// Only structured provider codes count as a capacity rejection. Diagnostic prose
// and arbitrary error bodies never enter either native frames or public output.
async function isWindowRejection(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 413 && response.status !== 422) return false;
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 8192) return false;
      chunks.push(next.value);
    }
    const json = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
    return ['context_length_exceeded', 'context_window_exceeded'].includes(json?.error?.code);
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Requires the caller's guarded streaming network executor; never falls back to fetch. */
export function createConfiguredSdkStep(
  config: SdkStepConfig,
  network: SdkStepNetwork,
): ModelStepTransport {
  if (typeof network !== 'function') throw new TypeError('model network executor is required');
  return createModelTransport(config, network);
}

/** Pull/ack transport: native alone chooses whether another model step is read. */
function createModelTransport(config: SdkStepConfig, network: SdkStepNetwork): ModelStepTransport {
  const { baseUrl, model, apiKey } = config;
  const diagnostic = config.diagnostic && { ...config.diagnostic };
  return async function* (request, tools, signal, authorizeDispatch) {
    if (request.remaining_tokens === 0)
      throw new ApplicationError(400008, 'BUDGET_EXCEEDED', 'harness token budget exhausted');
    const body = await serializeSdkRequest(model, request, tools);
    if (Buffer.byteLength(body, 'utf8') > HARNESS_MAX_FRAME_BYTES) throw contextLimit();
    const state: UsageState = { usage: null, sawContent: false, callOrder: [] };
    const transportAbort = new AbortController();
    const transportSignal = AbortSignal.any([signal, transportAbort.signal]);
    const fetcher: SdkFetch = async (url, init) => {
      try {
        if (init?.body !== body) throw modelProtocolError('request_body_mismatch');
        // Fail early before destination work; the executor must also check right before opening.
        await authorizeDispatch?.();
        transportSignal.throwIfAborted();
        const response = await network(
          url,
          { ...init, signal: transportSignal },
          authorizeDispatch,
        );
        if (!response.ok) {
          const capacity = await isWindowRejection(response);
          await response.body?.cancel().catch(() => undefined);
          throw capacity
            ? contextLimit()
            : new ModelUnavailableError('provider_http_error', response.status);
        }
        if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/event-stream') {
          await response.body?.cancel();
          throw modelProtocolError('response_not_event_stream');
        }
        return normalizeResponse(response, transportSignal, state);
      } catch (error) {
        if (error instanceof ApplicationError) {
          state.failure = error;
        } else {
          state.failure = outboundFailure(error) ?? new ModelUnavailableError('network_error');
        }
        throw error;
      }
    };
    try {
      const sdk = createSdkModel(baseUrl, model, apiKey, fetcher);
      const result = await sdk.doStream({
        ...sdkCallOptions(request, tools),
        abortSignal: transportSignal,
      });
      const content: string[] = [];
      const calls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }> = [];
      let hasContent = false;
      let finish = false;
      const reader = result.stream.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          const part = next.value;
          if (signal.aborted) throw signal.reason;
          if (part.type === 'error') throw modelProtocolError('sdk_stream_error');
          if (part.type === 'text-delta') {
            hasContent = true;
            content.push(part.delta);
            for (let offset = 0; offset < part.delta.length;) {
              let end = Math.min(offset + 4000, part.delta.length);
              if (end < part.delta.length && /[\uD800-\uDBFF]/.test(part.delta[end - 1]!)) end--;
              const delta = part.delta.slice(offset, end);
              if (!delta.isWellFormed()) throw modelProtocolError('sdk_invalid_unicode');
              yield { type: 'delta', delta };
              offset = end;
            }
          }
          if (part.type === 'tool-call')
            calls.push({
              id: part.toolCallId,
              type: 'function',
              function: { name: part.toolName, arguments: part.input },
            });
          if (part.type === 'finish') finish = true;
        }
      } finally {
        // SDK transforms may be pulling the provider while native is paused.
        // Abort first: cancelling a transform otherwise waits on that read.
        transportAbort.abort();
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (!finish) throw modelProtocolError('sdk_finish_missing');
      calls.sort((a, b) => state.callOrder.indexOf(a.id) - state.callOrder.indexOf(b.id));
      const parsed = HarnessModelReplySchema.safeParse({
        message: {
          content: hasContent || state.sawContent ? content.join('') : null,
          tool_calls: calls,
        },
        usage: state.usage,
      });
      if (!parsed.success) throw modelProtocolError('sdk_reply_invalid');
      if (
        Buffer.byteLength(JSON.stringify({ type: 'complete', reply: parsed.data }), 'utf8') >
        HARNESS_MAX_FRAME_BYTES - 256
      )
        throw modelProtocolError('sdk_reply_too_large');
      yield { type: 'complete', reply: parsed.data };
    } catch (error) {
      if (signal.aborted) throw error;
      const typed =
        state.failure ??
        (error instanceof ApplicationError ? error : new ModelUnavailableError('sdk_error'));
      const diagnosticFailure = outboundFailure(state.outboundError) ?? typed;
      if (diagnosticFailure instanceof ModelProtocolError) {
        console.warn(
          JSON.stringify({
            event: 'MODEL_PROTOCOL_REJECTED',
            reason: diagnosticFailure.reason,
            ...(diagnosticFailure.frame ? { frame: diagnosticFailure.frame } : {}),
            ...(state.finishReason ? { finish_reason: state.finishReason } : {}),
            ...(diagnostic
              ? {
                  run_id: diagnostic.runId,
                  attempt_id: diagnostic.attemptId,
                  operation: diagnostic.operation,
                }
              : {}),
          }),
        );
      }
      if (diagnosticFailure instanceof ModelUnavailableError) {
        console.warn(
          JSON.stringify({
            event: 'MODEL_TRANSPORT_UNAVAILABLE',
            reason: diagnosticFailure.reason,
            ...(diagnosticFailure.status === undefined ? {} : { status: diagnosticFailure.status }),
            ...(diagnostic
              ? {
                  run_id: diagnostic.runId,
                  attempt_id: diagnostic.attemptId,
                  operation: diagnostic.operation,
                }
              : {}),
          }),
        );
      }
      if (typed.errorCode === 'HARNESS_CONTEXT_LIMIT' && state.finishReason === 'length') {
        console.warn(
          JSON.stringify({
            event: 'MODEL_OUTPUT_LIMIT',
            max_output_tokens: request.max_output_tokens,
            ...(state.usage ? { usage_tokens: state.usage.total_tokens } : {}),
            ...(diagnostic
              ? {
                  run_id: diagnostic.runId,
                  attempt_id: diagnostic.attemptId,
                  operation: diagnostic.operation,
                }
              : {}),
          }),
        );
      }
      yield {
        type: 'failed',
        error: { code: typed.errorCode, message: typed.message },
        usage: state.usage,
      };
    }
  };
}
