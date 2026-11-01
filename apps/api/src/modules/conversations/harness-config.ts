import { accessSync, constants } from 'node:fs';
import { createHarnessModelTransport } from './harness-model.js';
import type { HarnessServices } from './harness-process.js';
import { createContextPolicy } from './context-policy.js';
import { measureHarnessContext } from './harness-context.js';
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
): HarnessServices | null {
  const baseUrl = environment.HARNESS_MODEL_BASE_URL;
  const model = environment.HARNESS_MODEL;
  if (!baseUrl || !model) return null;
  const binaryPath = environment.HARNESS_BINARY || '/app/harness/bin/along-harness';
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    accessSync(binaryPath, constants.X_OK);
  } catch {
    return null;
  }
  const apiKey = environment.HARNESS_MODEL_API_KEY;
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
      model,
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
    measure: measureHarnessContext,
    model: createHarnessModelTransport({ baseUrl, model, ...(apiKey ? { apiKey } : {}) }),
  };
}
