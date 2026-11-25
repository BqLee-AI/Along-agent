import type { ModelTransportFactory } from './model-contract.js';
import { createConfiguredSdkStep } from './sdk-step.js';
import { measureSdkContext } from './sdk-context.js';
import { outboundFetch } from '../outbound/outbound.js';

// A heuristic over the serialized request, not a provider tokenizer or usage.
const ESTIMATED_METER_REVISION = 'openai-json-utf8-estimate/1';

/** The selected version is the only model source for Run and probe calls. */
export const createUserModelTransport: ModelTransportFactory = async (config, diagnostic) => ({
  model: createConfiguredSdkStep(
    {
      baseUrl: config.base_url,
      model: config.model_id,
      ...(config.api_key === null ? {} : { apiKey: config.api_key }),
      ...(diagnostic ? { diagnostic } : {}),
    },
    outboundFetch,
  ),
  measure: async (request, tools, policy) => {
    if (policy.model_binding.model !== config.model_id) {
      throw new Error('model measurement binding mismatch');
    }
    return measureSdkContext(request, tools, policy, (body) =>
      policy.meter_revision === ESTIMATED_METER_REVISION
        ? {
            quality: 'estimated',
            input_tokens: Math.ceil(Buffer.byteLength(body, 'utf8') / 3),
            meter_revision: ESTIMATED_METER_REVISION,
          }
        : { quality: 'unavailable', input_tokens: null, meter_revision: 'unavailable/1' },
    );
  },
});
