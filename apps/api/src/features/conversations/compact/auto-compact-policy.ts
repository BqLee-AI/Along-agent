import { z } from 'zod';
import {
  ContextPolicySchema,
  HarnessContextMeasurementSchema,
  HARNESS_MAX_FRAME_BYTES,
  type ContextPolicy,
  type HarnessContextMeasurement,
} from '@along/contracts';

const positive = z.number().int().positive().safe();
const nonnegative = z.number().int().nonnegative().safe();

/** Frozen model and meter binding plus budget reserves. An evidence identifier
 * describes provenance; it does not assert empirical calibration. */
export const AutoCompactPolicySchema = z
  .object({
    evidenceId: z.string().trim().min(1).max(128),
    model: z.string().min(1).max(128),
    adapterRevision: z.string().min(1).max(128),
    meterRevision: z.string().min(1).max(128),
    windowTokens: positive,
    triggerRatio: z.number().finite().positive().max(1),
    compactInputTokens: positive,
    continuationTokens: positive,
    continuationIterations: positive,
  })
  .strict();

export type AutoCompactPolicy = z.infer<typeof AutoCompactPolicySchema>;
/** Without model metadata, bound the application's working context to a
 * conservative 16K-token planning envelope. This is not a provider window or
 * a claim about its occupancy; actual compact and continuation are remeasured. */
export function createAutoCompactPolicy(
  context: ContextPolicy,
  planningTokens = 16_384,
): AutoCompactPolicy | null {
  const parsed = ContextPolicySchema.safeParse(context);
  if (!parsed.success) return null;
  const c = parsed.data;
  if (c.input_meter === 'unavailable' || !positive.safeParse(planningTokens).success) return null;
  const windowTokens = c.model_window_tokens ?? planningTokens;
  return AutoCompactPolicySchema.parse({
    evidenceId:
      c.model_window_tokens === null
        ? 'application-envelope-estimate/1'
        : 'configured-window-estimate/1',
    model: c.model_binding.model,
    adapterRevision: c.model_binding.adapter_revision,
    meterRevision: c.meter_revision,
    windowTokens,
    triggerRatio: 0.8,
    compactInputTokens: Math.max(1, Math.ceil(windowTokens * 0.8)),
    continuationTokens: c.completion_cap,
    continuationIterations: 1,
  });
}

/** Pure trigger only; callers must freeze the policy at admission and perform
 * real compact and continuation measurement, authorization and budget checks. */
export function shouldAutoCompact(input: {
  policy: AutoCompactPolicy | null;
  contextPolicy: ContextPolicy;
  measurement: HarnessContextMeasurement;
  remainingTokens: number | null;
  maxOutputTokens: number;
  compactOutputTokens?: number;
  iterationsRemaining: number;
  uncoveredMessageCount: number;
}): boolean {
  const policy = AutoCompactPolicySchema.safeParse(input.policy);
  const context = ContextPolicySchema.safeParse(input.contextPolicy);
  const measurement = HarnessContextMeasurementSchema.safeParse(input.measurement);
  if (
    !policy.success ||
    !context.success ||
    !measurement.success ||
    !(input.remainingTokens === null || nonnegative.safeParse(input.remainingTokens).success) ||
    !positive.safeParse(input.maxOutputTokens).success ||
    !(
      input.compactOutputTokens === undefined ||
      positive.safeParse(input.compactOutputTokens).success
    ) ||
    !nonnegative.safeParse(input.iterationsRemaining).success ||
    !positive.safeParse(input.uncoveredMessageCount).success
  )
    return false;
  const p = policy.data;
  const c = context.data;
  const m = measurement.data;
  const remaining = input.remainingTokens;
  if (
    c.input_meter === 'unavailable' ||
    m.input_meter.quality === 'unavailable' ||
    m.input_meter.input_tokens === null ||
    (c.model_window_tokens === null && p.evidenceId !== 'application-envelope-estimate/1') ||
    c.model_binding.model !== p.model ||
    c.model_binding.adapter_revision !== p.adapterRevision ||
    c.meter_revision !== p.meterRevision ||
    m.input_meter.meter_revision !== p.meterRevision ||
    (c.model_window_tokens !== null && c.model_window_tokens !== p.windowTokens) ||
    m.limit_reason !== null ||
    m.wire_bytes > HARNESS_MAX_FRAME_BYTES ||
    m.http_bytes > HARNESS_MAX_FRAME_BYTES ||
    m.output_ceiling < input.maxOutputTokens ||
    input.maxOutputTokens > c.completion_cap ||
    // A nonempty compact request also needs input space in the known window.
    (c.model_window_tokens !== null &&
      (input.compactOutputTokens ?? input.maxOutputTokens) >=
        c.model_window_tokens - c.reserve_tokens) ||
    (c.model_window_tokens !== null &&
      (m.input_meter.input_tokens > p.windowTokens ||
        c.reserve_tokens > p.windowTokens - m.input_meter.input_tokens ||
        input.maxOutputTokens > p.windowTokens - m.input_meter.input_tokens - c.reserve_tokens)) ||
    input.iterationsRemaining <= p.continuationIterations ||
    (remaining !== null &&
      (remaining < p.compactInputTokens ||
        remaining - p.compactInputTokens < (input.compactOutputTokens ?? input.maxOutputTokens) ||
        remaining - p.compactInputTokens - (input.compactOutputTokens ?? input.maxOutputTokens) <
          p.continuationTokens))
  )
    return false;
  return m.input_meter.input_tokens / p.windowTokens >= p.triggerRatio;
}
