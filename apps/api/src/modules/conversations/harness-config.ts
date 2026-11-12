import { accessSync, constants } from 'node:fs';
import { createUserConfiguredHarnessModelTransport } from './harness-model.js';
import { createContextPolicy } from './context-policy.js';
import { measureHarnessContext } from './harness-context.js';
import { outboundFetch } from '../model-providers/outbound.js';
import type { ConversationDeps } from './contracts.js';
import { createRoutingRuntime, type RoutingRuntime } from './routing/index.js';

const routingByDeps = new WeakMap<ConversationDeps, RoutingRuntime>();

/** Freeze optional routing configuration once for each server dependency set. */
export function routingRuntimeOf(deps: ConversationDeps): RoutingRuntime {
  if (deps.routing) return deps.routing;
  let runtime = routingByDeps.get(deps);
  if (!runtime) {
    runtime = createRoutingRuntime({ mode: 'off' });
    routingByDeps.set(deps, runtime);
  }
  return runtime;
}

/** Called once by server startup. Missing configuration never enables a fixture. */
export function loadHarnessServices(
  environment: NodeJS.ProcessEnv = process.env,
): NonNullable<ConversationDeps['harness']> | null {
  const binaryPath = environment.HARNESS_BINARY || '/app/harness/bin/along-harness';
  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    return null;
  }
  // Deployment service budgets are frozen at acceptance and cumulative across
  // approval attempts. The document loop needs more than eight model rounds.
  const maxIterations = Number(environment.HARNESS_MAX_ITERATIONS ?? 24);
  const maxTokens = Number(environment.HARNESS_MAX_TOKENS ?? 64000);
  if (
    !Number.isSafeInteger(maxIterations) ||
    maxIterations < 1 ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1
  )
    return null;
  let contextPolicy;
  try {
    contextPolicy = createContextPolicy({
      // The accepted user selection replaces this template before persistence.
      model: 'unbound',
      completionCap: Number(environment.HARNESS_COMPLETION_CAP),
      ...(!environment.HARNESS_MODEL_WINDOW_TOKENS
        ? {}
        : { modelWindowTokens: Number(environment.HARNESS_MODEL_WINDOW_TOKENS) }),
      ...(environment.HARNESS_CONTEXT_RESERVE_TOKENS === undefined
        ? {}
        : { reserveTokens: Number(environment.HARNESS_CONTEXT_RESERVE_TOKENS) }),
    });
  } catch {
    return null;
  }
  return {
    binaryPath,
    libraryPath: environment.HARNESS_LIBRARY_PATH || '/app/harness/lib',
    maxIterations,
    maxTokens,
    contextPolicy,
  };
}

/** The selected version is the only model source for Run and probe calls. */
export const createUserModelTransport: NonNullable<ConversationDeps['modelTransport']> = async (
  config,
) => ({
  model: createUserConfiguredHarnessModelTransport(
    {
      baseUrl: config.base_url,
      model: config.model_id,
      ...(config.api_key === null ? {} : { apiKey: config.api_key }),
    },
    outboundFetch,
  ),
  measure: async (request, tools, policy) => {
    if (policy.model_binding.model !== config.model_id) {
      throw new Error('model measurement binding mismatch');
    }
    return measureHarnessContext(request, tools, policy);
  },
});
