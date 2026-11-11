import {
  HARNESS_MAX_FRAME_BYTES,
  type ContextPolicy,
  type HarnessContextMeasurement,
  type HarnessRequest,
  type HarnessTool,
} from '@along/contracts';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV2, LanguageModelV2CallOptions } from '@ai-sdk/provider';

type Candidate = Extract<HarnessRequest, { type: 'model' | 'measure_context' }>;
type InputMeter = HarnessContextMeasurement['input_meter'];
export type HarnessInputMeter = (body: string, policy: ContextPolicy) => InputMeter;
export type HarnessSdkFetch = (...args: Parameters<typeof fetch>) => Promise<Response>;

export function createHarnessSdkModel(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  fetcher: HarnessSdkFetch,
): LanguageModelV2 {
  return createOpenAICompatible({
    name: 'harness',
    baseURL: baseUrl.replace(/\/$/, ''),
    ...(apiKey ? { apiKey } : {}),
    includeUsage: true,
    // Preserve runtime-specific static fetch properties (e.g. Bun preconnect)
    // while routing every SDK request through the supplied boundary.
    fetch: new Proxy(globalThis.fetch, {
      apply(_target, _receiver, args: Parameters<typeof fetch>) {
        return fetcher(...args);
      },
    }),
    transformRequestBody: (body) => ({ ...body, parallel_tool_calls: false }),
  }).chatModel(model);
}

export function harnessSdkOptions(
  request: Candidate,
  tools: readonly HarnessTool[],
): LanguageModelV2CallOptions {
  const prompt = request.messages.map((message) => {
    if (message.role === 'system') return { role: 'system', content: message.content };
    if (message.role === 'user')
      return { role: 'user', content: [{ type: 'text', text: message.content }] };
    if (message.role === 'tool')
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.tool_call_id,
            toolName: '',
            output: { type: 'text', value: message.content },
          },
        ],
      };
    return {
      role: 'assistant',
      content: [
        { type: 'text', text: message.content },
        ...('tool_calls' in message
          ? message.tool_calls.map((call) => ({
              type: 'tool-call',
              toolCallId: call.id,
              toolName: call.function.name,
              // The native loop may retain malformed arguments for correction.
              // Provider metadata preserves their exact original wire string.
              input: call.function.arguments,
              providerOptions: {
                openaiCompatible: {
                  function: { name: call.function.name, arguments: call.function.arguments },
                },
              },
            }))
          : []),
      ],
    };
  });
  return {
    prompt,
    maxOutputTokens: request.max_output_tokens,
    tools: tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    })),
  } as LanguageModelV2CallOptions;
}

/** Ask the SDK to serialize without allowing an outbound request. */
export async function buildHarnessModelBody(
  model: string,
  request: Candidate,
  tools: readonly HarnessTool[],
): Promise<string> {
  let body: string | undefined;
  const capture: HarnessSdkFetch = async (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('SDK body is not text');
    body = init.body;
    throw new Error('local SDK serialization complete');
  };
  try {
    await createHarnessSdkModel(
      'https://measurement.invalid/v1',
      model,
      undefined,
      capture,
    ).doStream(harnessSdkOptions(request, tools));
  } catch {
    if (body === undefined) throw new Error('SDK request serialization failed');
  }
  if (body === undefined) throw new Error('SDK request serialization failed');
  return body;
}

/** Local only: no network, durable usage, or model iteration. */
export async function measureHarnessContext(
  request: Candidate,
  tools: readonly HarnessTool[],
  policy: ContextPolicy,
  meter?: HarnessInputMeter,
): Promise<HarnessContextMeasurement> {
  const body = await buildHarnessModelBody(policy.model_binding.model, request, tools);
  const httpBytes = Buffer.byteLength(body, 'utf8');
  const wireBytes = Buffer.byteLength(JSON.stringify({ ...request, type: 'model' }), 'utf8');
  let input: InputMeter = {
    quality: 'unavailable',
    input_tokens: null,
    meter_revision: 'unavailable/1',
  };
  if (meter && policy.input_meter !== 'unavailable') {
    const measured = meter(body, policy);
    if (
      measured.meter_revision === policy.meter_revision &&
      measured.quality !== 'unavailable' &&
      Number.isSafeInteger(measured.input_tokens) &&
      measured.input_tokens! >= 0
    ) {
      input = {
        ...measured,
        quality:
          measured.quality === 'verified' && policy.input_meter === 'verified'
            ? 'verified'
            : 'estimated',
      };
    }
  }
  const remaining = request.remaining_tokens;
  const p = input.input_tokens;
  let ceiling = policy.completion_cap;
  if (remaining !== null) ceiling = Math.min(ceiling, Math.max(0, remaining - (p ?? 0)));
  if (p !== null && policy.model_window_tokens !== null) {
    ceiling = Math.min(
      ceiling,
      Math.max(0, policy.model_window_tokens - p - policy.reserve_tokens),
    );
  }
  const exhausted =
    remaining !== null &&
    (remaining === 0 || (input.quality === 'verified' && p !== null && remaining - p < 1));
  const tooLarge =
    wireBytes > HARNESS_MAX_FRAME_BYTES ||
    httpBytes > HARNESS_MAX_FRAME_BYTES ||
    request.messages.length > 256 ||
    ceiling < 1;
  return {
    wire_bytes: wireBytes,
    http_bytes: httpBytes,
    input_meter: input,
    output_ceiling: ceiling,
    limit_reason: exhausted ? 'budget' : tooLarge ? 'context' : null,
  };
}
