import {
  createConfiguredSdkStep,
  type SdkStepConfig,
} from '../../src/features/model-providers/public.js';

/** Test-only SDK transport to a synthetic loopback HTTP provider. */
export function createLocalFixtureModelTransport(config: SdkStepConfig) {
  return createConfiguredSdkStep(config, async (url, init, authorizeDispatch) => {
    const target = new URL(url instanceof Request ? url.url : url);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') {
      throw new Error('expected a loopback model fixture');
    }
    if (!authorizeDispatch) return fetch(url, { ...init, redirect: 'error' });
    let response: Promise<Response> | undefined;
    await authorizeDispatch(() => {
      response = fetch(url, { ...init, redirect: 'error' });
      void response.catch(() => undefined);
    });
    if (!response) throw new Error('loopback model dispatch was not authorized');
    return response;
  });
}
