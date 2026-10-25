import { z } from 'zod';
import { HARNESS_MAX_FRAME_BYTES, HarnessModelReplySchema } from '@along/contracts';
import type { HarnessServices } from './harness-process.js';
import { HttpError } from '../../http/errors.js';

export interface HarnessModelConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

const ProviderReplySchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal('function'),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .max(1)
            .optional(),
        }),
      }),
    )
    .length(1),
  usage: z.object({ total_tokens: z.number().int().nonnegative().optional() }).nullish(),
});

function modelUnavailable(): HttpError {
  return new HttpError(503, 503, 'HARNESS_UNAVAILABLE', 'harness model transport unavailable');
}

function modelProtocolError(): HttpError {
  return new HttpError(502, 502, 'HARNESS_PROTOCOL_ERROR', 'harness model response rejected');
}

async function readModelJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw modelProtocolError();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > HARNESS_MAX_FRAME_BYTES) {
        await reader.cancel();
        throw modelProtocolError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
    return JSON.parse(text);
  } catch {
    throw modelProtocolError();
  }
}

/** Fixed server configuration; native owns messages, proposals and continuation. */
export function createHarnessModelTransport(config: HarnessModelConfig): HarnessServices['model'] {
  const base = config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`;
  const endpoint = new URL('chat/completions', base);
  return async (request, tools, signal) => {
    if (request.remaining_tokens === 0) {
      throw new HttpError(429, 400008, 'BUDGET_EXCEEDED', 'harness token budget exhausted');
    }
    const body = JSON.stringify({
      model: config.model,
      messages: request.messages,
      tools: tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      stream: false,
      max_tokens: request.remaining_tokens,
    });
    if (Buffer.byteLength(body, 'utf8') > HARNESS_MAX_FRAME_BYTES) throw modelProtocolError();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body,
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw modelUnavailable();
      }
      const parsed = ProviderReplySchema.safeParse(await readModelJson(response));
      if (!parsed.success) throw modelProtocolError();
      const message = parsed.data.choices[0]!.message;
      const tokens = parsed.data.usage?.total_tokens;
      const reply = HarnessModelReplySchema.safeParse({
        message: { content: message.content ?? null, tool_calls: message.tool_calls ?? [] },
        usage: tokens === undefined ? null : { total_tokens: tokens },
      });
      if (
        !reply.success ||
        (reply.data.message.content === null && reply.data.message.tool_calls.length === 0)
      ) {
        throw modelProtocolError();
      }
      return reply.data;
    } catch (error) {
      if (error instanceof HttpError || signal.aborted) throw error;
      throw modelUnavailable();
    }
  };
}
