import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { ProviderUpdate, ProviderView } from '@along/contracts';
import { decryptCredential, encryptCredential, credentialKey } from './crypto.js';
import { outboundJson } from '../outbound/outbound.js';
import { externalFailure } from '../outbound/errors.js';
import { withClient, withTransaction } from '../../../db/transaction.js';
import { isActiveOwner } from '../../identity/public.js';
import {
  ApplicationError,
  forbidden,
  notFound,
  stateConflict,
  validationError,
} from '../../../platform/errors.js';
import { lockOwner, type ModelSelection } from '../run-binding.js';

interface ProviderRow {
  id: string;
  owner_id: string;
  name: string;
  enabled: boolean;
  default_model_id: string | null;
  deleted_at: Date | null;
  current_version_id: string;
  base_url: string;
  credential_ciphertext: string | null;
}

export async function ownedProvider(
  client: PoolClient,
  ownerId: string,
  id: string,
  conflictIfDeleted = false,
): Promise<ProviderRow> {
  const result = await client.query<ProviderRow>(
    `SELECT p.*, v.base_url, v.credential_ciphertext
    FROM model_providers p JOIN model_provider_versions v ON v.id = p.current_version_id
    WHERE p.id = $1 FOR UPDATE OF p`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw notFound('provider not found');
  if (row.owner_id !== ownerId) throw forbidden();
  if (row.deleted_at)
    throw conflictIfDeleted
      ? stateConflict('provider changed during synchronization')
      : notFound('provider not found');
  return row;
}

function validateBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validationError('invalid base URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw validationError('invalid base URL');
}

async function providerView(client: PoolClient, row: ProviderRow): Promise<ProviderView> {
  const models = await client.query<{ model_id: string; context_window_tokens: number | null }>(
    'SELECT model_id, context_window_tokens::float8 AS context_window_tokens FROM model_provider_models WHERE provider_id = $1 ORDER BY model_id',
    [row.id],
  );
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    base_url: row.base_url,
    has_api_key: row.credential_ciphertext !== null,
    key_hint: null,
    default_model_id: row.default_model_id,
    models: models.rows.map((model) => model.model_id),
    model_context_windows: Object.fromEntries(
      models.rows.map((model) => [model.model_id, model.context_window_tokens]),
    ),
  };
}

export async function listProviders(
  pool: Pool,
  ownerId: string,
): Promise<{ items: ProviderView[]; default_selection: ModelSelection | null }> {
  return withClient(pool, async (client) => {
    const rows = await client.query<ProviderRow>(
      `SELECT p.*, v.base_url, v.credential_ciphertext
      FROM model_providers p JOIN model_provider_versions v ON v.id = p.current_version_id
      WHERE p.owner_id = $1 AND p.deleted_at IS NULL ORDER BY p.created_at, p.id`,
      [ownerId],
    );
    const items: ProviderView[] = [];
    for (const row of rows.rows) items.push(await providerView(client, row));
    const defaults = await client.query<ModelSelection>(
      'SELECT provider_id, model_id FROM model_provider_defaults WHERE owner_id = $1',
      [ownerId],
    );
    return { items, default_selection: defaults.rows[0] ?? null };
  });
}

export async function createProvider(
  pool: Pool,
  ownerId: string,
  name: string,
): Promise<ProviderView> {
  return withTransaction(pool, async (client) => {
    await lockOwner(client, ownerId);
    const id = randomUUID(),
      version = randomUUID();
    await client.query(
      'INSERT INTO model_providers (id,owner_id,name,current_version_id) VALUES ($1,$2,$3,$4)',
      [id, ownerId, name, version],
    );
    await client.query(
      'INSERT INTO model_provider_versions (id,owner_id,provider_id) VALUES ($1,$2,$3)',
      [version, ownerId, id],
    );
    return providerView(client, await ownedProvider(client, ownerId, id));
  });
}

export async function updateProvider(
  pool: Pool,
  ownerId: string,
  id: string,
  input: ProviderUpdate,
): Promise<ProviderView> {
  return withTransaction(pool, async (client) => {
    await lockOwner(client, ownerId);
    const row = await ownedProvider(client, ownerId, id);
    const credential = input.credential ?? { action: 'keep' as const };
    if (
      input.base_url !== undefined &&
      input.base_url !== row.base_url &&
      row.credential_ciphertext &&
      credential.action === 'keep'
    )
      throw validationError('changing endpoint requires replacing or clearing the credential');
    if (input.base_url) validateBaseUrl(input.base_url);
    const ciphertext =
      credential.action === 'replace'
        ? encryptCredential(credentialKey(), ownerId, id, credential.api_key)
        : credential.action === 'clear'
          ? null
          : row.credential_ciphertext;
    if (credential.action === 'clear')
      await client.query(
        'UPDATE model_provider_versions SET revoked_at = now(), credential_ciphertext = NULL WHERE owner_id = $1 AND provider_id = $2 AND revoked_at IS NULL',
        [ownerId, id],
      );
    const version = randomUUID();
    await client.query(
      'INSERT INTO model_provider_versions (id,owner_id,provider_id,base_url,credential_ciphertext) VALUES ($1,$2,$3,$4,$5)',
      [version, ownerId, id, input.base_url ?? row.base_url, ciphertext],
    );
    await client.query(
      'UPDATE model_providers SET name = $3, enabled = $4, current_version_id = $5 WHERE id = $1 AND owner_id = $2',
      [id, ownerId, input.name ?? row.name, input.enabled ?? row.enabled, version],
    );
    if (input.enabled === false)
      await client.query(
        'DELETE FROM model_provider_defaults WHERE owner_id = $1 AND provider_id = $2',
        [ownerId, id],
      );
    return providerView(client, await ownedProvider(client, ownerId, id));
  });
}

export async function deleteProvider(pool: Pool, ownerId: string, id: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockOwner(client, ownerId);
    await ownedProvider(client, ownerId, id);
    await client.query(
      'UPDATE model_provider_versions SET revoked_at = now(), credential_ciphertext = NULL WHERE owner_id = $1 AND provider_id = $2 AND revoked_at IS NULL',
      [ownerId, id],
    );
    await client.query(
      'DELETE FROM model_provider_defaults WHERE owner_id = $1 AND provider_id = $2',
      [ownerId, id],
    );
    await client.query(
      'UPDATE model_providers SET deleted_at = now(), default_model_id = NULL WHERE id = $1 AND owner_id = $2',
      [id, ownerId],
    );
  });
}

export async function addModel(
  pool: Pool,
  ownerId: string,
  id: string,
  modelId: string,
  contextWindowTokens: number | null = null,
): Promise<ProviderView> {
  return withTransaction(pool, async (client) => {
    await lockOwner(client, ownerId);
    const row = await ownedProvider(client, ownerId, id);
    await client.query(
      'INSERT INTO model_provider_models(provider_id,model_id,context_window_tokens) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [id, modelId, contextWindowTokens],
    );
    return providerView(client, row);
  });
}

export async function setModelContextWindow(
  pool: Pool,
  ownerId: string,
  id: string,
  modelId: string,
  contextWindowTokens: number | null,
): Promise<ProviderView> {
  return withTransaction(pool, async (client) => {
    await lockOwner(client, ownerId);
    const row = await ownedProvider(client, ownerId, id);
    const result = await client.query(
      'UPDATE model_provider_models SET context_window_tokens = $3 WHERE provider_id = $1 AND model_id = $2',
      [id, modelId, contextWindowTokens],
    );
    if (!result.rowCount) throw notFound('model not found');
    return providerView(client, row);
  });
}

export async function removeModel(
  pool: Pool,
  ownerId: string,
  id: string,
  modelId: string,
): Promise<ProviderView> {
  return withTransaction(pool, async (client) => {
    await lockOwner(client, ownerId);
    const row = await ownedProvider(client, ownerId, id);
    await client.query(
      'DELETE FROM model_provider_defaults WHERE owner_id = $1 AND provider_id = $2 AND model_id = $3',
      [ownerId, id, modelId],
    );
    if (row.default_model_id === modelId) {
      await client.query('UPDATE model_providers SET default_model_id = NULL WHERE id = $1', [id]);
      row.default_model_id = null;
    }
    await client.query(
      'DELETE FROM model_provider_models WHERE provider_id = $1 AND model_id = $2',
      [id, modelId],
    );
    return providerView(client, row);
  });
}

async function requireSelectableModel(client: PoolClient, row: ProviderRow, modelId: string) {
  const model = await client.query(
    'SELECT 1 FROM model_provider_models WHERE provider_id = $1 AND model_id = $2',
    [row.id, modelId],
  );
  if (!row.enabled || !row.base_url.trim() || !model.rowCount)
    throw stateConflict('model selection unavailable');
}

async function saveDefaultSelection(client: PoolClient, row: ProviderRow, modelId: string) {
  await client.query(
    'INSERT INTO model_provider_defaults(owner_id,provider_id,model_id) VALUES ($1,$2,$3) ON CONFLICT(owner_id) DO UPDATE SET provider_id=excluded.provider_id, model_id=excluded.model_id',
    [row.owner_id, row.id, modelId],
  );
}

export async function setDefault(
  pool: Pool,
  ownerId: string,
  selection: ModelSelection | null,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockOwner(client, ownerId);
    if (!selection) {
      await client.query('DELETE FROM model_provider_defaults WHERE owner_id = $1', [ownerId]);
      return;
    }
    const row = await ownedProvider(client, ownerId, selection.provider_id);
    await requireSelectableModel(client, row, selection.model_id);
    await client.query('UPDATE model_providers SET default_model_id = $2 WHERE id = $1', [
      selection.provider_id,
      selection.model_id,
    ]);
    await saveDefaultSelection(client, row, selection.model_id);
  });
}

export async function setProviderDefault(
  pool: Pool,
  ownerId: string,
  id: string,
  modelId: string | null,
): Promise<ProviderView> {
  return withTransaction(pool, async (client) => {
    await lockOwner(client, ownerId);
    const row = await ownedProvider(client, ownerId, id);
    if (modelId !== null) {
      await requireSelectableModel(client, row, modelId);
      await saveDefaultSelection(client, row, modelId);
    } else {
      await client.query(
        'DELETE FROM model_provider_defaults WHERE owner_id = $1 AND provider_id = $2',
        [ownerId, id],
      );
    }
    await client.query('UPDATE model_providers SET default_model_id = $2 WHERE id = $1', [
      id,
      modelId,
    ]);
    row.default_model_id = modelId;
    return providerView(client, row);
  });
}

export async function syncModels(
  pool: Pool,
  ownerId: string,
  id: string,
  request: typeof outboundJson = outboundJson,
): Promise<{ provider: ProviderView; added_model_ids: string[] }> {
  const row = await withTransaction(pool, async (client) => {
    await lockOwner(client, ownerId);
    const current = await ownedProvider(client, ownerId, id);
    if (!current.enabled || !current.base_url) throw stateConflict('provider unavailable');
    return current;
  });
  let data: unknown;
  try {
    const key = row.credential_ciphertext
      ? decryptCredential(credentialKey(), ownerId, id, row.credential_ciphertext)
      : null;
    data = await request(row.base_url, 'models', key);
  } catch (error) {
    externalFailure(error);
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !('data' in data) ||
    !Array.isArray(data.data) ||
    data.data.some(
      (item: unknown) =>
        !item ||
        typeof item !== 'object' ||
        !('id' in item) ||
        typeof item.id !== 'string' ||
        item.id.length === 0 ||
        item.id.length > 512,
    )
  )
    throw new ApplicationError(502, 'MODEL_PROVIDER_INCOMPATIBLE', 'model provider request failed');
  const ids = [...new Set((data.data as { id: string }[]).map((item) => item.id))];
  return withTransaction(pool, async (client) => {
    await lockOwner(client, ownerId);
    const current = await ownedProvider(client, ownerId, id, true);
    if (!current.enabled || current.current_version_id !== row.current_version_id)
      throw stateConflict('provider changed during synchronization');
    const added: string[] = [];
    for (const modelId of ids) {
      const result = await client.query(
        'INSERT INTO model_provider_models(provider_id,model_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING model_id',
        [id, modelId],
      );
      if (result.rowCount) added.push(modelId);
    }
    return { provider: await providerView(client, current), added_model_ids: added };
  });
}

/** Administrative import; the caller must explicitly supply the target owner and secret. */
export async function importLegacyProvider(
  pool: Pool,
  ownerId: string,
  input: { name: string; base_url: string; api_key: string | null; model_id: string },
): Promise<ProviderView> {
  validateBaseUrl(input.base_url);
  if (!input.name.trim() || !input.model_id || input.model_id.length > 512 || input.api_key === '')
    throw validationError('invalid import');
  return withTransaction(pool, async (client) => {
    await lockOwner(client, ownerId);
    if (!(await isActiveOwner(client, ownerId, { lock: 'share' })))
      throw notFound('active owner not found');
    const id = randomUUID(),
      version = randomUUID();
    const ciphertext =
      input.api_key === null
        ? null
        : encryptCredential(credentialKey(), ownerId, id, input.api_key);
    await client.query(
      'INSERT INTO model_providers(id,owner_id,name,current_version_id) VALUES ($1,$2,$3,$4)',
      [id, ownerId, input.name.trim(), version],
    );
    await client.query(
      'INSERT INTO model_provider_versions(id,owner_id,provider_id,base_url,credential_ciphertext) VALUES ($1,$2,$3,$4,$5)',
      [version, ownerId, id, input.base_url, ciphertext],
    );
    await client.query('INSERT INTO model_provider_models(provider_id,model_id) VALUES ($1,$2)', [
      id,
      input.model_id,
    ]);
    return providerView(client, await ownedProvider(client, ownerId, id));
  });
}
