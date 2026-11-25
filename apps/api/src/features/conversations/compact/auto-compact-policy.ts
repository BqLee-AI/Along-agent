import { z } from 'zod';
import { ContextPolicySchema, type ContextPolicy } from '@along/contracts';

const positive = z.number().int().positive().safe();

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
