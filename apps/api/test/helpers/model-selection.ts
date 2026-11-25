import type { Pool } from 'pg';
import {
  addModel,
  createProvider,
  setDefault,
  updateProvider,
} from '../../src/features/model-providers/public.js';
import type { ConversationDeps, HarnessServices } from '../../src/agent/execution/contracts.js';
import { measureSdkContext } from '../../src/features/model-providers/public.js';

/** Controlled legacy transport seam; not SDK, outbound-policy or provider acceptance coverage. */
export function controlledModelDeps<T extends ConversationDeps>(deps: T): T {
  deps.modelTransport = async () => {
    const harness = deps.harness as HarnessServices;
    return {
      model: harness.model,
      measure: harness.measure ?? measureSdkContext,
    };
  };
  return deps;
}

/** Configure an isolated test owner; never imports deployment configuration or credentials. */
export async function configureTestModel(
  pool: Pool,
  ownerId: string,
  model: string,
): Promise<void> {
  const provider = await createProvider(pool, ownerId, 'Controlled fixture');
  await updateProvider(pool, ownerId, provider.id, {
    base_url: 'https://controlled-fixture.invalid/v1',
  });
  await addModel(pool, ownerId, provider.id, model);
  await setDefault(pool, ownerId, { provider_id: provider.id, model_id: model });
}
