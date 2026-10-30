import {
  HARNESS_MAX_FRAME_BYTES,
  type ContextPolicy,
  type HarnessContextMeasurement,
  type HarnessRequest,
  type HarnessTool,
} from '@along/contracts';

type Candidate = Extract<HarnessRequest, { type: 'model' | 'measure_context' }>;
type InputMeter = HarnessContextMeasurement['input_meter'];
export type HarnessInputMeter = (body: string, policy: ContextPolicy) => InputMeter;

/** The HTTP body used for measurement is exactly the body sent by transport. */
export function buildHarnessModelBody(
  model: string,
  request: Candidate,
  tools: readonly HarnessTool[],
): string {
  return JSON.stringify({
    model,
    messages: request.messages,
    tools: tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
    stream: true,
    stream_options: { include_usage: true },
    parallel_tool_calls: false,
    max_tokens: request.max_output_tokens,
  });
}

/** Local only: no network, durable usage, or model iteration. */
export function measureHarnessContext(
  request: Candidate,
  tools: readonly HarnessTool[],
  policy: ContextPolicy,
  meter?: HarnessInputMeter,
): HarnessContextMeasurement {
  const body = buildHarnessModelBody(policy.model_binding.model, request, tools);
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
