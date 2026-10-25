import { accessSync, constants } from 'node:fs';
import { createHarnessModelTransport } from './harness-model.js';
import type { HarnessServices } from './harness-process.js';

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
  return {
    binaryPath,
    libraryPath: environment.HARNESS_LIBRARY_PATH || '/app/harness/lib',
    maxIterations: 8,
    maxTokens: 8000,
    model: createHarnessModelTransport({ baseUrl, model, ...(apiKey ? { apiKey } : {}) }),
  };
}
