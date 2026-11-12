import type { Pool } from 'pg';
import {
  addModel,
  createProvider,
  setDefault,
  updateProvider,
} from '../../src/modules/model-providers/service.js';
import type { ConversationDeps } from '../../src/modules/conversations/contracts.js';
import { measureHarnessContext } from '../../src/modules/conversations/harness-context.js';
import type { HarnessServices } from '../../src/modules/conversations/harness-process.js';

/** Controlled legacy transport seam; not SDK, outbound-policy or provider acceptance coverage. */
export function controlledModelDeps<T extends ConversationDeps>(deps: T): T {
  deps.modelTransport = async () => {
    const harness = deps.harness as HarnessServices;
    return {
      model: harness.model,
      measure: harness.measure ?? measureHarnessContext,
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
