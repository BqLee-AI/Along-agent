import type {
  ContextPolicy,
  HarnessContextMeasurement,
  HarnessModelStep,
  HarnessRequest,
  HarnessTool,
} from '@along/contracts';
import type { AuthorizeDispatch } from '../outbound/outbound.js';

export type ModelStepTransport = (
  request: Extract<HarnessRequest, { type: 'model' }>,
  tools: readonly HarnessTool[],
  signal: AbortSignal,
  authorizeDispatch?: AuthorizeDispatch,
) => AsyncGenerator<HarnessModelStep, void, unknown>;

export type ModelContextMeasurement = (
  request: Extract<HarnessRequest, { type: 'measure_context' }>,
  tools: readonly HarnessTool[],
  policy: ContextPolicy,
) => HarnessContextMeasurement | Promise<HarnessContextMeasurement>;

/** An adapter must enforce outbound policy and measure its actual serialized request. */
export type ModelTransportFactory = (
  config: { base_url: string; api_key: string | null; model_id: string },
  diagnostic?: { runId: string; attemptId: string; operation: 'compact' | 'model' },
) => Promise<{ model: ModelStepTransport; measure: ModelContextMeasurement }>;
