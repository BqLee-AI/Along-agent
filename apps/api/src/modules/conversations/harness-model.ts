import { z } from 'zod';
import { HARNESS_MAX_FRAME_BYTES, HarnessModelReplySchema } from '@along/contracts';
import type { HarnessServices } from './harness-process.js';
import {
  buildHarnessModelBody,
  createHarnessSdkModel,
  harnessSdkOptions,
  type HarnessSdkFetch,
} from './harness-context.js';
import { HttpError } from '../../http/errors.js';

export interface HarnessModelConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** Returns the live response body; the executor owns destination and redirect policy. */
export type HarnessModelNetwork = HarnessSdkFetch;

// Provider metadata may evolve; choice/function identity must remain unambiguous.
const ProviderChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        delta: z.object({
          role: z.literal('assistant').optional(),
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                index: z.number().int().min(0).max(63),
                id: z.string().optional(),
                type: z.literal('function').optional(),
                function: z
                  .object({ name: z.string().optional(), arguments: z.string().optional() })
                  .optional(),
              }),
            )
            .max(64)
            .optional(),
        }),
        finish_reason: z
          .enum(['stop', 'tool_calls', 'length', 'content_filter'])
          .nullable()
          .optional(),
      }),
    )
    .max(1),
  usage: z.object({ total_tokens: z.number().int().safe().nonnegative() }).nullish(),
});
function modelUnavailable(): HttpError {
  return new HttpError(503, 503, 'HARNESS_UNAVAILABLE', 'harness model transport unavailable');
}
function modelProtocolError(): HttpError {
  return new HttpError(502, 502, 'HARNESS_PROTOCOL_ERROR', 'harness model response rejected');
}
function contextLimit(): HttpError {
  return new HttpError(
    422,
    422,
    'HARNESS_CONTEXT_LIMIT',
    'harness model context capacity exceeded',
  );
}

/** SSE lines are decoded only when complete, including complete UTF-8 scalars. */
async function* modelEvents(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) throw modelProtocolError();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const line = new Uint8Array(HARNESS_MAX_FRAME_BYTES);
  let length = 0;
  let eventBytes = 0;
  let transportBytes = 0;
  let data: string[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      transportBytes += next.value.byteLength;
      if (transportBytes > HARNESS_MAX_FRAME_BYTES * 16) throw modelProtocolError();
      for (const byte of next.value) {
        if (++eventBytes > HARNESS_MAX_FRAME_BYTES) throw modelProtocolError();
        if (byte !== 10) {
          if (length === line.length) throw modelProtocolError();
          line[length++] = byte;
          continue;
        }
        const end = length > 0 && line[length - 1] === 13 ? length - 1 : length;
        let value: string;
        try {
          value = decoder.decode(line.subarray(0, end));
        } catch {
          throw modelProtocolError();
        }
        length = 0;
        if (value === '') {
          const event = data.join('\n');
          data = [];
          eventBytes = 0;
          if (event !== '') yield event;
        } else if (value.startsWith('data:')) {
          data.push(value.slice(value[5] === ' ' ? 6 : 5));
        }
      }
    }
    throw modelProtocolError(); // Truncation and a missing [DONE] are failures.
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
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

type UsageState = {
  usage: { total_tokens: number } | null;
  failure?: HttpError;
  sawContent: boolean;
  callOrder: string[];
};

// Validate the original stream and normalize fragmented tool identities into the
// complete identity form required by the SDK. Text remains incremental.
async function* normalizedEvents(
  response: Response,
  signal: AbortSignal,
  state: UsageState,
): AsyncGenerator<string> {
  const emit = (delta: unknown, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  // Text is validated and forwarded to the SDK rather than accumulated here.
  const calls: Array<
    | {
        ids: string[];
        names: string[];
        argumentsParts: string[];
        hasFunctionType: boolean;
        idUnits: number;
        nameUnits: number;
      }
    | undefined
  > = [];
  let hasContent = false;
  let finish: string | undefined;
  let outputBytes = 0;
  const account = (fragment: string) => {
    outputBytes += Buffer.byteLength(JSON.stringify(fragment), 'utf8') - 2;
    if (outputBytes > HARNESS_MAX_FRAME_BYTES - 1024) throw modelProtocolError();
  };
  for await (const event of modelEvents(response)) {
    if (signal.aborted) throw signal.reason;
    if (event === '[DONE]') {
      if (finish === 'length') throw contextLimit();
      if (
        !finish ||
        (!hasContent && calls.length === 0) ||
        (finish === 'tool_calls') !== calls.length > 0
      )
        throw modelProtocolError();
      const toolCalls = [];
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index];
        if (!call?.hasFunctionType) throw modelProtocolError();
        toolCalls.push({
          id: call.ids.join(''),
          type: 'function' as const,
          function: { name: call.names.join(''), arguments: call.argumentsParts.join('') },
        });
      }
      if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length)
        throw modelProtocolError();
      state.callOrder = toolCalls.map((call) => call.id);
      const reply = HarnessModelReplySchema.safeParse({
        message: {
          content: hasContent ? '' : null,
          tool_calls: toolCalls,
        },
        usage: state.usage,
      });
      if (
        !reply.success ||
        Buffer.byteLength(JSON.stringify({ type: 'complete', reply: reply.data }), 'utf8') >
          HARNESS_MAX_FRAME_BYTES - 256
      )
        throw modelProtocolError();
      if (toolCalls.length) {
        yield emit({ tool_calls: toolCalls.map((call, index) => ({ index, ...call })) });
      }
      yield emit({}, finish);
      if (state.usage) yield `data: ${JSON.stringify({ choices: [], usage: state.usage })}\n\n`;
      yield 'data: [DONE]\n\n';
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(event);
    } catch {
      throw modelProtocolError();
    }
    const parsed = ProviderChunkSchema.safeParse(json);
    if (!parsed.success) throw modelProtocolError();
    const chunk = parsed.data;
    if (chunk.usage) {
      if (state.usage !== null) throw modelProtocolError();
      state.usage = chunk.usage;
    }
    const choice = chunk.choices[0];
    if (!choice) {
      if (!chunk.usage || !finish) throw modelProtocolError();
      continue;
    }
    if (finish) throw modelProtocolError();
    const fragment = choice.delta.content;
    if (fragment !== undefined && fragment !== null) {
      account(fragment);
      hasContent = true;
      state.sawContent = true;
      if (!fragment.isWellFormed()) throw modelProtocolError();
      yield emit({ content: fragment });
    }
    for (const call of choice.delta.tool_calls ?? []) {
      const current = (calls[call.index] ??= {
        ids: [],
        names: [],
        argumentsParts: [],
        hasFunctionType: false,
        idUnits: 0,
        nameUnits: 0,
      });
      if (call.type === 'function') current.hasFunctionType = true;
      for (const [value, parts] of [
        [call.id, current.ids],
        [call.function?.name, current.names],
        [call.function?.arguments, current.argumentsParts],
      ] as const) {
        if (value !== undefined) {
          account(value);
          parts.push(value);
        }
      }
      current.idUnits += call.id?.length ?? 0;
      current.nameUnits += call.function?.name?.length ?? 0;
      if (current.idUnits > 128 || current.nameUnits > 128) throw modelProtocolError();
    }
    if (choice.finish_reason === 'content_filter') throw modelProtocolError();
    // Read the usage-only trailer before turning length into a failed step.
    if (choice.finish_reason) finish = choice.finish_reason;
  }
}

function normalizeResponse(response: Response, signal: AbortSignal, state: UsageState): Response {
  const events = normalizedEvents(response, signal, state);
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await events.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        } catch (error) {
          if (error instanceof HttpError) state.failure = error;
          controller.error(error);
        }
      },
      async cancel() {
        await events.return(undefined);
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

/** Deployment-only legacy transport; user-selected endpoints must use the guarded factory. */
export function createHarnessModelTransport(config: HarnessModelConfig): HarnessServices['model'] {
  return createModelTransport(config, (url, init) => fetch(url, init));
}

/** Requires the caller's guarded streaming network executor; never falls back to fetch. */
export function createUserConfiguredHarnessModelTransport(
  config: HarnessModelConfig,
  network: HarnessModelNetwork,
): HarnessServices['model'] {
  if (typeof network !== 'function') throw new TypeError('model network executor is required');
  return createModelTransport(config, network);
}

/** Pull/ack transport: native alone chooses whether another model step is read. */
function createModelTransport(
  config: HarnessModelConfig,
  network: HarnessModelNetwork,
): HarnessServices['model'] {
  const { baseUrl, model, apiKey } = config;
  return async function* (request, tools, signal) {
    if (request.remaining_tokens === 0)
      throw new HttpError(429, 400008, 'BUDGET_EXCEEDED', 'harness token budget exhausted');
    const body = await buildHarnessModelBody(model, request, tools);
    if (Buffer.byteLength(body, 'utf8') > HARNESS_MAX_FRAME_BYTES) throw contextLimit();
    const state: UsageState = { usage: null, sawContent: false, callOrder: [] };
    const transportAbort = new AbortController();
    const transportSignal = AbortSignal.any([signal, transportAbort.signal]);
    const fetcher: HarnessSdkFetch = async (url, init) => {
      try {
        if (init?.body !== body) throw modelProtocolError();
        const response = await network(url, { ...init, signal: transportSignal });
        if (!response.ok) {
          const capacity = await isWindowRejection(response);
          await response.body?.cancel().catch(() => undefined);
          throw capacity ? contextLimit() : modelUnavailable();
        }
        if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/event-stream') {
          await response.body?.cancel();
          throw modelProtocolError();
        }
        return normalizeResponse(response, transportSignal, state);
      } catch (error) {
        if (error instanceof HttpError) state.failure = error;
        throw error;
      }
    };
    try {
      const sdk = createHarnessSdkModel(baseUrl, model, apiKey, fetcher);
      const result = await sdk.doStream({
        ...harnessSdkOptions(request, tools),
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
          if (part.type === 'error') throw modelProtocolError();
          if (part.type === 'text-delta') {
            hasContent = true;
            content.push(part.delta);
            for (let offset = 0; offset < part.delta.length;) {
              let end = Math.min(offset + 4000, part.delta.length);
              if (end < part.delta.length && /[\uD800-\uDBFF]/.test(part.delta[end - 1]!)) end--;
              const delta = part.delta.slice(offset, end);
              if (!delta.isWellFormed()) throw modelProtocolError();
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
      if (!finish) throw modelProtocolError();
      calls.sort((a, b) => state.callOrder.indexOf(a.id) - state.callOrder.indexOf(b.id));
      const parsed = HarnessModelReplySchema.safeParse({
        message: {
          content: hasContent || state.sawContent ? content.join('') : null,
          tool_calls: calls,
        },
        usage: state.usage,
      });
      if (
        !parsed.success ||
        Buffer.byteLength(JSON.stringify({ type: 'complete', reply: parsed.data }), 'utf8') >
          HARNESS_MAX_FRAME_BYTES - 256
      )
        throw modelProtocolError();
      yield { type: 'complete', reply: parsed.data };
    } catch (error) {
      if (signal.aborted) throw error;
      const typed = state.failure ?? (error instanceof HttpError ? error : modelUnavailable());
      yield {
        type: 'failed',
        error: { code: typed.errorCode, message: typed.message },
        usage: state.usage,
      };
    }
  };
}
