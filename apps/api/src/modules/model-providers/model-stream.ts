import { z } from 'zod';
import { HARNESS_MAX_FRAME_BYTES, HarnessModelReplySchema } from '@along/contracts';
import { HttpError } from '../../http/errors.js';
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
type SafeFrame = {
  choice_count: number | null;
  has_usage: boolean;
  has_finish_reason: boolean;
  has_tool_calls: boolean;
};
export class ModelProtocolError extends HttpError {
  constructor(
    readonly reason: string,
    readonly frame?: SafeFrame,
  ) {
    super(502, 502, 'HARNESS_PROTOCOL_ERROR', 'harness model response rejected');
  }
}
export function modelProtocolError(reason: string, frame?: SafeFrame): ModelProtocolError {
  return new ModelProtocolError(reason, frame);
}
export function contextLimit(): HttpError {
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
  if (!reader) throw modelProtocolError('stream_body_missing');
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
      if (transportBytes > HARNESS_MAX_FRAME_BYTES * 16)
        throw modelProtocolError('stream_too_large');
      for (const byte of next.value) {
        if (++eventBytes > HARNESS_MAX_FRAME_BYTES) throw modelProtocolError('event_too_large');
        if (byte !== 10) {
          if (length === line.length) throw modelProtocolError('line_too_large');
          line[length++] = byte;
          continue;
        }
        const end = length > 0 && line[length - 1] === 13 ? length - 1 : length;
        let value: string;
        try {
          value = decoder.decode(line.subarray(0, end));
        } catch {
          throw modelProtocolError('stream_invalid_utf8');
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
    throw modelProtocolError('stream_missing_done');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export type UsageState = {
  usage: { total_tokens: number } | null;
  failure?: HttpError;
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter';
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
    if (outputBytes > HARNESS_MAX_FRAME_BYTES - 1024) throw modelProtocolError('output_too_large');
  };
  for await (const event of modelEvents(response)) {
    if (signal.aborted) throw signal.reason;
    if (event === '[DONE]') {
      if (finish === 'length') throw contextLimit();
      if (!finish) throw modelProtocolError('finish_missing');
      if (!hasContent && calls.length === 0) throw modelProtocolError('empty_response');
      if ((finish === 'tool_calls') !== calls.length > 0)
        throw modelProtocolError('finish_tool_mismatch');
      const toolCalls = [];
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index];
        if (!call?.hasFunctionType) throw modelProtocolError('tool_type_missing');
        toolCalls.push({
          id: call.ids.join(''),
          type: 'function' as const,
          function: { name: call.names.join(''), arguments: call.argumentsParts.join('') },
        });
      }
      if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length)
        throw modelProtocolError('tool_id_duplicate');
      state.callOrder = toolCalls.map((call) => call.id);
      const reply = HarnessModelReplySchema.safeParse({
        message: {
          content: hasContent ? '' : null,
          tool_calls: toolCalls,
        },
        usage: state.usage,
      });
      if (!reply.success) throw modelProtocolError('provider_reply_invalid');
      if (
        Buffer.byteLength(JSON.stringify({ type: 'complete', reply: reply.data }), 'utf8') >
        HARNESS_MAX_FRAME_BYTES - 256
      )
        throw modelProtocolError('provider_reply_too_large');
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
      throw modelProtocolError('event_invalid_json');
    }
    const parsed = ProviderChunkSchema.safeParse(json);
    if (!parsed.success) {
      const object =
        json && typeof json === 'object' && !Array.isArray(json)
          ? (json as Record<string, unknown>)
          : {};
      const choices = Array.isArray(object.choices) ? object.choices : null;
      const choice =
        choices?.[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0])
          ? (choices[0] as Record<string, unknown>)
          : {};
      const delta =
        choice.delta && typeof choice.delta === 'object' && !Array.isArray(choice.delta)
          ? (choice.delta as Record<string, unknown>)
          : {};
      throw modelProtocolError('event_schema_invalid', {
        choice_count: choices?.length ?? null,
        has_usage: Object.hasOwn(object, 'usage'),
        has_finish_reason: Object.hasOwn(choice, 'finish_reason'),
        has_tool_calls: Object.hasOwn(delta, 'tool_calls'),
      });
    }
    const chunk = parsed.data;
    if (chunk.usage) {
      if (state.usage !== null) throw modelProtocolError('usage_duplicate');
      state.usage = chunk.usage;
    }
    const choice = chunk.choices[0];
    if (!choice) {
      if (!chunk.usage || !finish) throw modelProtocolError('usage_frame_unexpected');
      continue;
    }
    if (finish) throw modelProtocolError('choice_after_finish');
    const fragment = choice.delta.content;
    if (fragment !== undefined && fragment !== null) {
      account(fragment);
      hasContent = true;
      state.sawContent = true;
      if (!fragment.isWellFormed()) throw modelProtocolError('content_invalid_unicode');
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
      if (current.idUnits > 128 || current.nameUnits > 128)
        throw modelProtocolError('tool_identity_too_large');
    }
    if (choice.finish_reason) state.finishReason = choice.finish_reason;
    if (choice.finish_reason === 'content_filter') throw modelProtocolError('content_filtered');
    // Read the usage-only trailer before turning length into a failed step.
    if (choice.finish_reason) finish = choice.finish_reason;
  }
}

export function normalizeResponse(
  response: Response,
  signal: AbortSignal,
  state: UsageState,
): Response {
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
