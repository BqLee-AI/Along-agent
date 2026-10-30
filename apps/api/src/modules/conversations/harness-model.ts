import { z } from 'zod';
import { HARNESS_MAX_FRAME_BYTES, HarnessModelReplySchema } from '@along/contracts';
import type { HarnessServices } from './harness-process.js';
import { HttpError } from '../../http/errors.js';

export interface HarnessModelConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

// Provider envelopes are external data, not the native wire DTOs. Unknown
// provider metadata is ignored; choices and function proposals are never selected.
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
                index: z.literal(0),
                id: z.string().optional(),
                type: z.literal('function').optional(),
                function: z
                  .object({ name: z.string().optional(), arguments: z.string().optional() })
                  .optional(),
              }),
            )
            .max(1)
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

/** Decode complete SSE lines, not arbitrary HTTP chunks or partial UTF-8. */
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
    // A truncated event or missing [DONE] is never a completed model result.
    throw modelProtocolError();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Fixed server configuration; native pulls each step and owns continuation. */
export function createHarnessModelTransport(config: HarnessModelConfig): HarnessServices['model'] {
  const base = config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`;
  const endpoint = new URL('chat/completions', base);
  return async function* (request, tools, signal) {
    if (request.remaining_tokens === 0) {
      throw new HttpError(429, 400008, 'BUDGET_EXCEEDED', 'harness token budget exhausted');
    }
    const body = JSON.stringify({
      model: config.model,
      messages: request.messages,
      tools: tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      stream: true,
      stream_options: { include_usage: true },
      parallel_tool_calls: false,
      max_tokens: request.remaining_tokens,
    });
    if (Buffer.byteLength(body, 'utf8') > HARNESS_MAX_FRAME_BYTES) throw modelProtocolError();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body,
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw modelUnavailable();
      }
      if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/event-stream') {
        await response.body?.cancel();
        throw modelProtocolError();
      }
      const content: string[] = [];
      const ids: string[] = [];
      const names: string[] = [];
      const argumentsParts: string[] = [];
      let hasContent = false;
      let hasTool = false;
      let hasFunctionType = false;
      let finish: string | undefined;
      let usage: { total_tokens: number } | null = null;
      let outputBytes = 0;
      let idUnits = 0;
      let nameUnits = 0;
      const account = (fragment: string) => {
        // Escaped JSON size, including tool argument escaping, bounds the final
        // native frame before retaining any unbounded accumulated content.
        outputBytes += Buffer.byteLength(JSON.stringify(fragment), 'utf8') - 2;
        if (outputBytes > HARNESS_MAX_FRAME_BYTES - 1024) throw modelProtocolError();
      };
      for await (const event of modelEvents(response)) {
        if (signal.aborted) throw signal.reason;
        if (event === '[DONE]') {
          if (
            !finish ||
            (!hasContent && !hasTool) ||
            (finish === 'tool_calls') !== hasTool ||
            (hasTool && !hasFunctionType)
          )
            throw modelProtocolError();
          const reply = HarnessModelReplySchema.safeParse({
            message: {
              content: hasContent ? content.join('') : null,
              tool_calls: hasTool
                ? [
                    {
                      id: ids.join(''),
                      type: 'function',
                      function: { name: names.join(''), arguments: argumentsParts.join('') },
                    },
                  ]
                : [],
            },
            usage,
          });
          if (
            !reply.success ||
            Buffer.byteLength(JSON.stringify({ type: 'complete', reply: reply.data }), 'utf8') >
              HARNESS_MAX_FRAME_BYTES - 256
          )
            throw modelProtocolError();
          yield { type: 'complete', reply: reply.data };
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
          if (usage !== null) throw modelProtocolError();
          usage = chunk.usage;
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
          content.push(fragment);
          // This only bounds an actual provider delta for the public event
          // contract. It never slices a completed model answer to mimic timing.
          for (let offset = 0; offset < fragment.length;) {
            if (signal.aborted) throw signal.reason;
            let end = Math.min(offset + 4000, fragment.length);
            if (end < fragment.length && /[\uD800-\uDBFF]/.test(fragment[end - 1]!)) end--;
            const delta = fragment.slice(offset, end);
            if (!delta.isWellFormed()) throw modelProtocolError();
            yield { type: 'delta', delta };
            offset = end;
          }
        }
        const call = choice.delta.tool_calls?.[0];
        if (call) {
          hasTool = true;
          if (call.type === 'function') hasFunctionType = true;
          for (const [value, parts] of [
            [call.id, ids],
            [call.function?.name, names],
            [call.function?.arguments, argumentsParts],
          ] as const) {
            if (value !== undefined) {
              account(value);
              parts.push(value);
            }
          }
          idUnits += call.id?.length ?? 0;
          nameUnits += call.function?.name?.length ?? 0;
          if (idUnits > 128 || nameUnits > 128) throw modelProtocolError();
        }
        if (choice.finish_reason === 'length')
          throw new HttpError(429, 400008, 'BUDGET_EXCEEDED', 'harness model token limit reached');
        if (choice.finish_reason === 'content_filter') throw modelProtocolError();
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (error) {
      if (error instanceof HttpError || signal.aborted) throw error;
      throw modelUnavailable();
    }
  };
}
