import { z } from 'zod';

const modelId = z.string().min(1).max(512);
const name = z.string().trim().min(1).max(200);
export const ModelSelectionSchema = z
  .object({ provider_id: z.string().uuid(), model_id: modelId })
  .strict();
export const ProviderCredentialSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('replace'), api_key: z.string().min(1).max(16384) }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
]);
export const ProviderCreateSchema = z.object({ name }).strict();
export const ProviderUpdateSchema = z
  .object({
    name: name.optional(),
    enabled: z.boolean().optional(),
    base_url: z.string().max(2048).optional(),
    credential: ProviderCredentialSchema.optional(),
  })
  .strict();
export const ProviderConnectionTestSchema = z
  .object({
    base_url: z.string().max(2048).optional(),
    credential: ProviderCredentialSchema.optional(),
  })
  .strict();
export const ProviderTestSchema = ProviderConnectionTestSchema.extend({
  model_id: modelId,
});
export const ProviderConnectionTestResultSchema = z
  .object({ status: z.literal('passed'), latency_ms: z.number().nonnegative() })
  .strict();
const contextWindowTokens = z.number().int().positive().safe().nullable();
export const ProviderModelSchema = z.object({ model_id: modelId }).strict();
export const ProviderModelCreateSchema = z
  .object({ model_id: modelId, context_window_tokens: contextWindowTokens.optional() })
  .strict();
export const ProviderModelContextWindowSchema = z
  .object({ model_id: modelId, context_window_tokens: contextWindowTokens })
  .strict();
export const ProviderDefaultSchema = z
  .object({ selection: ModelSelectionSchema.nullable() })
  .strict();
export const ProviderModelDefaultSchema = z.object({ model_id: modelId.nullable() }).strict();
export const EmptyActionSchema = z.object({}).strict();
export const ProviderViewSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    enabled: z.boolean(),
    base_url: z.string(),
    has_api_key: z.boolean(),
    key_hint: z.null(),
    default_model_id: modelId.nullable(),
    models: z.array(modelId),
    model_context_windows: z.record(z.string(), contextWindowTokens),
  })
  .strict();
export const ProviderListSchema = z
  .object({
    items: z.array(ProviderViewSchema),
    default_selection: ModelSelectionSchema.nullable(),
  })
  .strict();
export const ProviderTestResultSchema = z
  .object({
    text_stream: z
      .object({
        status: z.enum(['passed', 'failed', 'not_tested']),
        latency_ms: z.number().nullable(),
      })
      .strict(),
    tool_round_trip: z
      .object({
        status: z.enum(['passed', 'failed', 'not_tested']),
        latency_ms: z.number().nullable(),
      })
      .strict(),
    usage: z
      .object({
        status: z.enum(['passed', 'failed', 'not_tested']),
        latency_ms: z.number().nullable(),
      })
      .strict(),
  })
  .strict();
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
export type ProviderUpdate = z.infer<typeof ProviderUpdateSchema>;
export type ProviderConnectionTest = z.infer<typeof ProviderConnectionTestSchema>;
export type ProviderTest = z.infer<typeof ProviderTestSchema>;
export type ProviderView = z.infer<typeof ProviderViewSchema>;
