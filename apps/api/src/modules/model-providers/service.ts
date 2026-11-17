import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  HARNESS_PROTOCOL_VERSION,
  HarnessModelStepSchema,
  type HarnessModelReply,
  type HarnessRequest,
  type HarnessTool,
  type ProviderConnectionTest,
  type ProviderTest,
  type ProviderUpdate,
  type ProviderView,
} from '@along/contracts';
import { decryptCredential, encryptCredential, credentialKey } from './crypto.js';
import { outboundJson, OutboundError } from './outbound.js';
import { withClient, withTransaction } from '../../db/transaction.js';
import { isActiveOwner } from '../identity/preferences.js';
import {
  HttpError,
  forbidden,
  notFound,
  notReady,
  stateConflict,
  validationError,
} from '../../http/errors.js';
import type { ConversationDeps } from '../conversations/contracts.js';
import type { HarnessServices } from '../conversations/harness-process.js';

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
  const run = await client.query('SELECT 1 FROM agent_runs WHERE id = $1 AND owner_id = $2', [
    runId,
    ownerId,
  ]);
  if (!run.rowCount) throw notFound('run not found');
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

async function ownedProvider(
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
    if (input.base_url) {
      try {
        const url = new URL(input.base_url);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hash ||
          url.search
        )
          throw new Error();
      } catch {
        throw validationError('invalid base URL');
      }
    }
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
    const model = await client.query(
      'SELECT 1 FROM model_provider_models WHERE provider_id = $1 AND model_id = $2',
      [selection.provider_id, selection.model_id],
    );
    if (!row.enabled || !row.base_url.trim() || !model.rowCount)
      throw stateConflict('model selection unavailable');
    await client.query('UPDATE model_providers SET default_model_id = $2 WHERE id = $1', [
      selection.provider_id,
      selection.model_id,
    ]);
    await client.query(
      'INSERT INTO model_provider_defaults(owner_id,provider_id,model_id) VALUES ($1,$2,$3) ON CONFLICT(owner_id) DO UPDATE SET provider_id=excluded.provider_id, model_id=excluded.model_id',
      [ownerId, selection.provider_id, selection.model_id],
    );
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
      const model = await client.query(
        'SELECT 1 FROM model_provider_models WHERE provider_id = $1 AND model_id = $2',
        [id, modelId],
      );
      if (!row.enabled || !row.base_url.trim() || !model.rowCount)
        throw stateConflict('model selection unavailable');
      await client.query(
        'INSERT INTO model_provider_defaults(owner_id,provider_id,model_id) VALUES ($1,$2,$3) ON CONFLICT(owner_id) DO UPDATE SET provider_id=excluded.provider_id, model_id=excluded.model_id',
        [ownerId, id, modelId],
      );
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

function externalFailure(error: unknown): never {
  if (!(error instanceof OutboundError)) throw error;
  const codes = {
    invalid_endpoint: [400, 'MODEL_ENDPOINT_INVALID'],
    blocked_address: [403, 'MODEL_ENDPOINT_BLOCKED'],
    timeout: [504, 'MODEL_PROVIDER_TIMEOUT'],
    connection: [502, 'MODEL_PROVIDER_CONNECTION'],
    authentication: [502, 'MODEL_PROVIDER_AUTHENTICATION'],
    unsupported: [502, 'MODEL_PROVIDER_UNSUPPORTED'],
    incompatible: [502, 'MODEL_PROVIDER_INCOMPATIBLE'],
  } as const;
  const [status, code] = codes[error.category];
  throw new HttpError(status, status, code, 'model provider request failed');
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
    throw new HttpError(502, 502, 'MODEL_PROVIDER_INCOMPATIBLE', 'model provider request failed');
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

type ProbeResult = {
  text_stream: ProbeStatus;
  tool_round_trip: ProbeStatus;
  usage: ProbeStatus;
};
type ProbeStatus = { status: 'passed' | 'failed' | 'not_tested'; latency_ms: number | null };
const untested = (): ProbeStatus => ({ status: 'not_tested', latency_ms: null });
const probeTool: HarnessTool = {
  name: 'probe_echo',
  description: 'Return the supplied synthetic value.',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
  risk: 'low',
};

async function resolveProbeConfig(
  pool: Pool,
  ownerId: string,
  id: string,
  input: ProviderConnectionTest,
): Promise<{ baseUrl: string; key: string | null }> {
  const row = await withTransaction(pool, async (client) => {
    await lockOwner(client, ownerId);
    const current = await ownedProvider(client, ownerId, id);
    const action = input.credential?.action ?? 'keep';
    if (input.base_url !== undefined && input.base_url !== current.base_url && action === 'keep')
      throw validationError('changing endpoint requires replacing or clearing the credential');
    return current;
  });
  const baseUrl = input.base_url ?? row.base_url;
  if (!baseUrl) throw stateConflict('provider unavailable');
  const action = input.credential ?? { action: 'keep' as const };
  const key =
    action.action === 'replace'
      ? action.api_key
      : action.action === 'clear'
        ? null
        : row.credential_ciphertext
          ? decryptCredential(credentialKey(), ownerId, id, row.credential_ciphertext)
          : null;
  return { baseUrl, key };
}

/** Probe the provider endpoint without synchronizing or changing its configuration. */
export async function testProviderConnection(
  pool: Pool,
  ownerId: string,
  id: string,
  input: ProviderConnectionTest,
  request: typeof outboundJson = outboundJson,
): Promise<{ status: 'passed'; latency_ms: number }> {
  const { baseUrl, key } = await resolveProbeConfig(pool, ownerId, id, input);
  const start = performance.now();
  try {
    await request(baseUrl, 'models', key);
  } catch (error) {
    externalFailure(error);
  }
  return { status: 'passed', latency_ms: Math.max(0, Math.round(performance.now() - start)) };
}

/** Uses the same single-step transport as inference, never a business tool gateway. */
export async function testProvider(
  pool: Pool,
  ownerId: string,
  id: string,
  input: ProviderTest,
  factory?: ConversationDeps['modelTransport'],
  signal?: AbortSignal,
): Promise<ProbeResult> {
  if (!input.model_id) throw validationError('model id required');
  const { baseUrl, key } = await resolveProbeConfig(pool, ownerId, id, input);
  const result: ProbeResult = {
    text_stream: untested(),
    tool_round_trip: untested(),
    usage: untested(),
  };
  if (!factory) throw notReady('model provider test transport unavailable');
  const probeSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const abortable = async <T>(promise: Promise<T>): Promise<T> => {
    if (probeSignal.aborted) {
      void promise.catch(() => undefined);
      throw probeSignal.reason;
    }
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(probeSignal.reason);
      probeSignal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      probeSignal.removeEventListener('abort', onAbort);
    }
  };
  let model: HarnessServices['model'];
  try {
    if (probeSignal.aborted) throw probeSignal.reason;
    model = (
      await abortable(factory({ base_url: baseUrl, api_key: key, model_id: input.model_id }))
    ).model;
  } catch (error) {
    if (probeSignal.aborted)
      throw new HttpError(504, 504, 'MODEL_PROVIDER_TIMEOUT', 'model provider request failed');
    if (error instanceof OutboundError) externalFailure(error);
    throw new HttpError(502, 502, 'MODEL_PROVIDER_CONNECTION', 'model provider request failed');
  }
  const start = performance.now();
  const measured = (status: 'passed' | 'failed', since: number): ProbeStatus => ({
    status,
    latency_ms: Math.max(0, Math.round(performance.now() - since)),
  });
  const run = async (
    messages: Extract<HarnessRequest, { type: 'model' }>['messages'],
    tools: readonly HarnessTool[],
  ) => {
    let reply: HarnessModelReply | undefined;
    let delta = false;
    const request: Extract<HarnessRequest, { type: 'model' }> = {
      protocol: HARNESS_PROTOCOL_VERSION,
      request_ref: randomUUID(),
      type: 'model',
      messages,
      remaining_tokens: 512,
      max_output_tokens: 128,
    };
    let size = 0;
    const stream = model(request, tools, probeSignal);
    try {
      while (true) {
        if (probeSignal.aborted) throw probeSignal.reason;
        const step = await abortable(stream.next());
        if (step.done) break;
        const raw = step.value;
        size += Buffer.byteLength(JSON.stringify(raw), 'utf8');
        if (size > 1024 * 1024) throw new OutboundError('incompatible');
        const parsed = HarnessModelStepSchema.safeParse(raw);
        if (!parsed.success || reply || parsed.data.type === 'failed')
          throw new OutboundError('incompatible');
        if (parsed.data.type === 'delta') delta = true;
        else reply = parsed.data.reply;
      }
    } finally {
      void stream.return(undefined).catch(() => undefined);
    }
    if (!reply) throw new OutboundError('incompatible');
    if (reply.usage !== null && result.usage.status !== 'passed')
      result.usage = measured('passed', start);
    return { reply, delta };
  };
  try {
    const text = await run([{ role: 'user', content: 'Reply with a short greeting.' }], []);
    result.text_stream = measured(text.delta ? 'passed' : 'failed', start);
  } catch (error) {
    if (error instanceof OutboundError) externalFailure(error);
    throw new HttpError(
      probeSignal.aborted ? 504 : 502,
      probeSignal.aborted ? 504 : 502,
      probeSignal.aborted ? 'MODEL_PROVIDER_TIMEOUT' : 'MODEL_PROVIDER_CONNECTION',
      'model provider request failed',
    );
  }
  const toolStart = performance.now();
  try {
    const initial = await run(
      [{ role: 'user', content: 'Call probe_echo with value "probe", then respond briefly.' }],
      [probeTool],
    );
    const calls = initial.reply.message.tool_calls;
    if (calls.length !== 1 || calls[0]!.function.name !== probeTool.name) {
      result.tool_round_trip = measured('failed', toolStart);
    } else {
      const call = calls[0]!;
      const args: unknown = JSON.parse(call.function.arguments);
      if (!args || typeof args !== 'object' || !('value' in args) || args.value !== 'probe')
        throw new Error('invalid probe call');
      const final = await run(
        [
          { role: 'user', content: 'Call probe_echo with value "probe", then respond briefly.' },
          { role: 'assistant', content: initial.reply.message.content ?? '', tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: 'probe' },
        ],
        [probeTool],
      );
      result.tool_round_trip = measured(
        final.reply.message.tool_calls.length === 0 &&
          (final.delta || !!final.reply.message.content)
          ? 'passed'
          : 'failed',
        toolStart,
      );
    }
  } catch {
    if (probeSignal.aborted)
      throw new HttpError(504, 504, 'MODEL_PROVIDER_TIMEOUT', 'model provider request failed');
    result.tool_round_trip = measured('failed', toolStart);
  }
  if (result.usage.status === 'not_tested') result.usage = measured('failed', start);
  return result;
}

/** Administrative import; the caller must explicitly supply the target owner and secret. */
export async function importLegacyProvider(
  pool: Pool,
  ownerId: string,
  input: { name: string; base_url: string; api_key: string | null; model_id: string },
): Promise<ProviderView> {
  let url: URL;
  try {
    url = new URL(input.base_url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw validationError('invalid base URL');
  }
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
