import {
  createConfiguredSdkStep,
  type SdkStepConfig,
} from '../../src/features/model-providers/public.js';

/** Test-only SDK transport to a synthetic loopback HTTP provider. */
export function createLocalFixtureModelTransport(config: SdkStepConfig) {
  return createConfiguredSdkStep(config, (url, init) => {
    const target = new URL(url instanceof Request ? url.url : url);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') {
      throw new Error('expected a loopback model fixture');
    }
    return fetch(url, { ...init, redirect: 'error' });
  });
}
