import { accessSync, constants } from 'node:fs';
import { createContextPolicy } from '../features/conversations/public.js';
import type { ConversationDeps } from '../agent/execution/contracts.js';
import { ESTIMATED_METER_REVISION } from '../features/model-providers/public.js';

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
  const autoCompactPlanningTokens = Number(
    environment.HARNESS_AUTO_COMPACT_PLANNING_TOKENS ?? 16384,
  );
  if (
    !Number.isSafeInteger(maxIterations) ||
    maxIterations < 1 ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    !Number.isSafeInteger(autoCompactPlanningTokens) ||
    autoCompactPlanningTokens < 1
  )
    return null;
  let contextPolicy;
  try {
    contextPolicy = createContextPolicy({
      // The accepted user selection replaces this template before persistence.
      model: 'unbound',
      completionCap: Number(environment.HARNESS_COMPLETION_CAP),
      inputMeter: 'estimated',
      meterRevision: ESTIMATED_METER_REVISION,
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
  const compactCompletionCap = Number(
    environment.HARNESS_COMPACT_COMPLETION_CAP ?? Math.max(contextPolicy.completion_cap, 4096),
  );
  if (!Number.isSafeInteger(compactCompletionCap) || compactCompletionCap < 1) return null;
  return {
    binaryPath,
    libraryPath: environment.HARNESS_LIBRARY_PATH || '/app/harness/lib',
    maxIterations,
    maxTokens,
    autoCompactPlanningTokens,
    compactCompletionCap,
    contextPolicy,
  };
}
