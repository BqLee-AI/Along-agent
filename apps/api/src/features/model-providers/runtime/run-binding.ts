import type { PoolClient } from 'pg';
import { assertOwnedRun } from '../../conversations/run/ownership.js';
import { decryptCredential, credentialKey } from '../configuration/crypto.js';
import { forbidden, notFound, stateConflict } from '../../../platform/errors.js';

export type ModelSelection = { provider_id: string; model_id: string };
export type ResolvedSelection = ModelSelection & {
  provider_name: string;
  version_id: string;
  context_window_tokens: number | null;
};
export type RunSelectionView = ModelSelection & { state: 'available'; provider_name: string };

/** Serialize owner configuration decisions, including the absence of a default. */
export async function lockOwner(client: PoolClient, ownerId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ownerId]);
}

export async function resolveSelection(
  client: PoolClient,
  ownerId: string,
  selection?: ModelSelection | null,
): Promise<ResolvedSelection> {
  await lockOwner(client, ownerId);
  let selected = selection;
  if (!selected) {
    const defaults = await client.query<ModelSelection>(
      'SELECT provider_id, model_id FROM model_provider_defaults WHERE owner_id = $1',
      [ownerId],
    );
    selected = defaults.rows[0];
  }
  if (!selected) throw stateConflict('model selection required');
  const provider = await client.query<{
    owner_id: string;
    name: string;
    enabled: boolean;
    deleted_at: Date | null;
    current_version_id: string;
    base_url: string;
  }>(
    `SELECT p.owner_id, p.name, p.enabled, p.deleted_at, p.current_version_id, v.base_url
       FROM model_providers p JOIN model_provider_versions v ON v.id = p.current_version_id
      WHERE p.id = $1 FOR UPDATE OF p`,
    [selected.provider_id],
  );
  const row = provider.rows[0];
  if (!row || row.deleted_at) throw notFound('provider not found');
  if (row.owner_id !== ownerId) throw forbidden();
  const model = await client.query<{ context_window_tokens: number | null }>(
    'SELECT context_window_tokens::float8 AS context_window_tokens FROM model_provider_models WHERE provider_id = $1 AND model_id = $2',
    [selected.provider_id, selected.model_id],
  );
  if (!row.enabled || !row.base_url || !model.rowCount)
    throw stateConflict('model selection unavailable');
  return {
    ...selected,
    provider_name: row.name,
    version_id: row.current_version_id,
    context_window_tokens: model.rows[0]!.context_window_tokens,
  };
}

export async function bindRunSelection(
  client: PoolClient,
  ownerId: string,
  runId: string,
  selected: ResolvedSelection,
): Promise<void> {
  await assertOwnedRun(client, ownerId, runId);
  const inserted = await client.query(
    `INSERT INTO model_provider_run_bindings (run_id, owner_id, version_id, provider_id, provider_name, model_id, context_window_tokens)
    SELECT $1, $2, id, provider_id, $5, $6, $7 FROM model_provider_versions
    WHERE id = $3 AND owner_id = $2 AND provider_id = $4 AND revoked_at IS NULL`,
    [
      runId,
      ownerId,
      selected.version_id,
      selected.provider_id,
      selected.provider_name,
      selected.model_id,
      selected.context_window_tokens,
    ],
  );
  if (!inserted.rowCount) throw stateConflict('model version unavailable');
}

export async function getRunSelections(
  client: PoolClient,
  ownerId: string,
  runIds: string[],
): Promise<Map<string, RunSelectionView>> {
  if (!runIds.length) return new Map();
  const result = await client.query<{
    run_id: string;
    provider_id: string;
    provider_name: string;
    model_id: string;
  }>(
    'SELECT run_id, provider_id, provider_name, model_id FROM model_provider_run_bindings WHERE owner_id = $1 AND run_id = ANY($2::uuid[])',
    [ownerId, runIds],
  );
  return new Map(
    result.rows.map(({ run_id, ...view }) => [run_id, { state: 'available' as const, ...view }]),
  );
}

/** Check the bound version's authority without reading or decrypting credentials. */
export async function isRunSelectionUsable(
  client: PoolClient,
  ownerId: string,
  runId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM model_provider_run_bindings b
       JOIN model_provider_versions v ON v.id = b.version_id AND v.owner_id = b.owner_id AND v.provider_id = b.provider_id
      WHERE b.run_id = $1 AND b.owner_id = $2 AND v.revoked_at IS NULL`,
    [runId, ownerId],
  );
  return !!result.rowCount;
}

/** Lock the frozen version against revocation for the caller's transaction. */
export async function lockUsableRunModel(
  client: PoolClient,
  ownerId: string,
  runId: string,
): Promise<string | null> {
  const result = await client.query<{ model_id: string }>(
    `SELECT b.model_id FROM model_provider_run_bindings b
     JOIN model_provider_versions v ON v.id=b.version_id AND v.owner_id=b.owner_id AND v.provider_id=b.provider_id
     WHERE b.run_id=$1 AND b.owner_id=$2 AND v.revoked_at IS NULL FOR SHARE OF v`,
    [runId, ownerId],
  );
  return result.rows[0]?.model_id ?? null;
}

export async function resolveRunSelection(
  client: PoolClient,
  ownerId: string,
  runId: string,
): Promise<{
  base_url: string;
  api_key: string | null;
  model_id: string;
  context_window_tokens: number | null;
} | null> {
  const result = await client.query<{
    provider_id: string;
    base_url: string;
    credential_ciphertext: string | null;
    revoked_at: Date | null;
    model_id: string;
    context_window_tokens: number | null;
  }>(
    `SELECT b.provider_id, b.model_id, b.context_window_tokens::float8 AS context_window_tokens, v.base_url, v.credential_ciphertext, v.revoked_at
       FROM model_provider_run_bindings b JOIN model_provider_versions v ON v.id = b.version_id AND v.owner_id = b.owner_id AND v.provider_id = b.provider_id
      WHERE b.run_id = $1 AND b.owner_id = $2`,
    [runId, ownerId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.revoked_at) throw stateConflict('model credential revoked');
  return {
    base_url: row.base_url,
    model_id: row.model_id,
    context_window_tokens: row.context_window_tokens,
    api_key: row.credential_ciphertext
      ? decryptCredential(credentialKey(), ownerId, row.provider_id, row.credential_ciphertext)
      : null,
  };
}
