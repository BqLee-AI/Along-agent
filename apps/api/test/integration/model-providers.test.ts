import { httpStatusForError } from '@along/contracts';
import { ApplicationError } from '../../src/platform/errors.js';
import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { ProviderViewSchema } from '@along/contracts';
import { handleRequest } from '../helpers/http-app.js';
import { csrfTokenFor } from '../../src/http/auth.js';
import {
  createProvider,
  updateProvider,
  addModel,
  removeModel,
  setModelContextWindow,
  setDefault,
  setProviderDefault,
  listProviders,
  deleteProvider,
  syncModels,
} from '../../src/features/model-providers/configuration/service.js';
import {
  resolveSelection,
  bindRunSelection,
  resolveRunSelection,
  getRunSelections,
} from '../../src/features/model-providers/runtime/run-binding.js';

const schema = `provider_test_${randomUUID().replaceAll('-', '')}`;
const url = process.env.MODEL_PROVIDER_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;
const admin = new Pool({ connectionString: url ?? 'postgresql://invalid' });
const pool = new Pool({
  connectionString: url ?? 'postgresql://invalid',
  options: `-c search_path=${schema}`,
});
const owner = randomUUID();
const other = randomUUID();
suite('provider settings', () => {
  beforeAll(async () => {
    process.env.MODEL_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(
      "CREATE TABLE schema_migrations(version text PRIMARY KEY); INSERT INTO schema_migrations(version) VALUES ('0027')",
    );
    await pool.query('CREATE TABLE agent_runs(id uuid PRIMARY KEY, owner_id uuid NOT NULL)');
    await pool.query(
      await readFile(
        new URL('../../../../infra/migrations/0028_model_providers.sql', import.meta.url),
        'utf8',
      ),
    );
    const legacyProvider = randomUUID();
    const legacyVersion = randomUUID();
    const legacyRun = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO model_providers(id,owner_id,name,current_version_id) VALUES ($1,$2,$3,$4)',
        [legacyProvider, other, 'legacy', legacyVersion],
      );
      await client.query(
        'INSERT INTO model_provider_versions(id,owner_id,provider_id) VALUES ($1,$2,$3)',
        [legacyVersion, other, legacyProvider],
      );
      await client.query('INSERT INTO model_provider_models(provider_id,model_id) VALUES ($1,$2)', [
        legacyProvider,
        'old',
      ]);
      await client.query(
        'INSERT INTO model_provider_defaults(owner_id,provider_id,model_id) VALUES ($1,$2,$3)',
        [other, legacyProvider, 'old'],
      );
      await client.query('INSERT INTO agent_runs(id,owner_id) VALUES ($1,$2)', [legacyRun, other]);
      await client.query(
        'INSERT INTO model_provider_run_bindings(run_id,owner_id,version_id,provider_id,provider_name,model_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [legacyRun, other, legacyVersion, legacyProvider, 'legacy', 'old'],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    // This isolated provider-only fixture omits unrelated 0029–0036 tables.
    await pool.query("INSERT INTO schema_migrations(version) VALUES ('0036')");
    await pool.query(
      await readFile(
        new URL('../../../../infra/migrations/0037_model_context_windows.sql', import.meta.url),
        'utf8',
      ),
    );
    expect(
      (
        await pool.query(
          'SELECT context_window_tokens FROM model_provider_models WHERE provider_id=$1',
          [legacyProvider],
        )
      ).rows[0].context_window_tokens,
    ).toBeNull();
    expect(
      (
        await pool.query(
          'SELECT context_window_tokens FROM model_provider_run_bindings WHERE run_id=$1',
          [legacyRun],
        )
      ).rows[0].context_window_tokens,
    ).toBeNull();
    await pool.query(
      await readFile(
        new URL('../../../../infra/migrations/0038_model_provider_defaults.sql', import.meta.url),
        'utf8',
      ),
    );
    expect(
      (await listProviders(pool, other)).items.find((item) => item.id === legacyProvider)
        ?.default_model_id,
    ).toBe('old');
    expect((await listProviders(pool, other)).default_selection).toEqual({
      provider_id: legacyProvider,
      model_id: 'old',
    });
  });
  afterAll(async () => {
    delete process.env.MODEL_PROVIDER_ENCRYPTION_KEY;
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  test('HTTP model windows support create, edit, clearing and owner isolation', async () => {
    const provider = await createProvider(pool, owner, 'HTTP windows');
    const actor = {
      ownerId: owner,
      sessionId: randomUUID(),
      displayName: 'Test',
      timezoneId: null,
    };
    const server = createServer((req, res) => {
      void handleRequest(req, res, {
        pool,
        tzdbVersion: 'fixture-v1',
        resolveActor: async () => actor,
      });
    });
    const started = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', started.resolve);
    await started.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const base = `http://127.0.0.1:${address.port}/api/v1/model-providers/${provider.id}/models`;
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrfTokenFor(actor)! };
    const post = (suffix: string, body: unknown) =>
      fetch(base + suffix, { method: 'POST', headers, body: JSON.stringify(body) });
    try {
      let response = await post('', { model_id: 'vendor/model', context_window_tokens: 8192 });
      expect(response.status).toBe(200);
      let body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('missing data');
      expect(ProviderViewSchema.parse(body.data).model_context_windows).toEqual({
        'vendor/model': 8192,
      });
      response = await post('', {
        model_id: 'large',
        context_window_tokens: Number.MAX_SAFE_INTEGER,
      });
      body = await response.json();
      if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('missing data');
      expect(ProviderViewSchema.parse(body.data).model_context_windows.large).toBe(
        Number.MAX_SAFE_INTEGER,
      );
      response = await post('/actions/context-window', {
        model_id: 'vendor/model',
        context_window_tokens: 16384,
      });
      body = await response.json();
      if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('missing data');
      expect(ProviderViewSchema.parse(body.data).model_context_windows['vendor/model']).toBe(16384);
      expect(
        (
          await post('/actions/context-window', {
            model_id: 'vendor/model',
            context_window_tokens: 0,
          })
        ).status,
      ).toBe(400);
      actor.ownerId = other;
      expect(
        (
          await post('/actions/context-window', {
            model_id: 'vendor/model',
            context_window_tokens: null,
          })
        ).status,
      ).toBe(403);
      actor.ownerId = owner;
      response = await post('/actions/context-window', {
        model_id: 'vendor/model',
        context_window_tokens: null,
      });
      body = await response.json();
      if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('missing data');
      expect(ProviderViewSchema.parse(body.data).model_context_windows['vendor/model']).toBeNull();
      expect(
        (
          await post('/actions/context-window', {
            model_id: 'missing',
            context_window_tokens: null,
          })
        ).status,
      ).toBe(404);
    } finally {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      await closed.promise;
    }
  });
  test('HTTP provider default model action validates its body and enforces ownership', async () => {
    const account = randomUUID();
    const provider = await createProvider(pool, account, 'HTTP default');
    await updateProvider(pool, account, provider.id, { base_url: 'https://example.test/v1' });
    await addModel(pool, account, provider.id, 'vendor/model');
    const actor = {
      ownerId: account,
      sessionId: randomUUID(),
      displayName: 'Test',
      timezoneId: null,
    };
    const server = createServer((req, res) => {
      void handleRequest(req, res, {
        pool,
        tzdbVersion: 'fixture-v1',
        resolveActor: async () => actor,
      });
    });
    const started = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', started.resolve);
    await started.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/model-providers/${provider.id}/actions/default-model`;
    const headers = { 'content-type': 'application/json', 'x-csrf-token': csrfTokenFor(actor)! };
    const post = (body: unknown) =>
      fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    try {
      for (const body of [
        {},
        { model_id: '' },
        { model_id: 123 },
        { model_id: 'x'.repeat(513) },
        { model_id: 'vendor/model', extra: true },
      ]) {
        expect((await post(body)).status).toBe(400);
      }
      expect((await post({ model_id: 'missing' })).status).toBe(409);
      actor.ownerId = randomUUID();
      expect((await post({ model_id: 'vendor/model' })).status).toBe(403);
      actor.ownerId = account;
      let response = await post({ model_id: 'vendor/model' });
      expect(response.status).toBe(200);
      let body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('missing data');
      expect(ProviderViewSchema.parse(body.data).default_model_id).toBe('vendor/model');
      expect((await listProviders(pool, account)).default_selection).toEqual({
        provider_id: provider.id,
        model_id: 'vendor/model',
      });
      response = await post({ model_id: null });
      expect(response.status).toBe(200);
      body = await response.json();
      if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('missing data');
      expect(ProviderViewSchema.parse(body.data).default_model_id).toBeNull();
      expect((await listProviders(pool, account)).default_selection).toBeNull();
    } finally {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      await closed.promise;
    }
  });
  test('credentials are private and endpoint changes require explicit credential action', async () => {
    const provider = await createProvider(pool, owner, 'Example');
    await updateProvider(pool, owner, provider.id, {
      base_url: 'https://example.test/v1',
      credential: { action: 'replace', api_key: 'secret' },
    });
    const view = await listProviders(pool, owner);
    expect(JSON.stringify(view)).not.toContain('secret');
    expect(view.items.find((item) => item.id === provider.id)?.has_api_key).toBe(true);
    await expect(
      updateProvider(pool, owner, provider.id, { base_url: 'https://other.test/v1' }),
    ).rejects.toThrow();
    await expect(updateProvider(pool, other, provider.id, { name: 'stolen' })).rejects.toThrow();
    await updateProvider(pool, owner, provider.id, {
      base_url: 'https://other.test/v1',
      credential: { action: 'clear' },
    });
    expect(
      (await listProviders(pool, owner)).items.find((item) => item.id === provider.id)?.has_api_key,
    ).toBe(false);
  });
  test('removing the selected model clears the default', async () => {
    const provider = await createProvider(pool, owner, 'Selection');
    await updateProvider(pool, owner, provider.id, { base_url: 'https://example.test/v1' });
    await addModel(pool, owner, provider.id, 'vendor/model');
    await setDefault(pool, owner, { provider_id: provider.id, model_id: 'vendor/model' });
    await removeModel(pool, owner, provider.id, 'vendor/model');
    expect(
      (await listProviders(pool, owner)).items.find((item) => item.id === provider.id)
        ?.default_model_id,
    ).toBeNull();
    expect((await listProviders(pool, owner)).default_selection).toBeNull();
  });
  test('provider defaults persist independently and synchronize with the global default', async () => {
    const account = randomUUID();
    const first = await createProvider(pool, account, 'First');
    const second = await createProvider(pool, account, 'Second');
    await updateProvider(pool, account, first.id, { base_url: 'https://first.test/v1' });
    await updateProvider(pool, account, second.id, { base_url: 'https://second.test/v1' });
    await addModel(pool, account, first.id, 'first-model');
    await addModel(pool, account, second.id, 'second-model');
    expect(
      (await setProviderDefault(pool, account, first.id, 'first-model')).default_model_id,
    ).toBe('first-model');
    expect(
      (await setProviderDefault(pool, account, second.id, 'second-model')).default_model_id,
    ).toBe('second-model');
    let state = await listProviders(pool, account);
    expect(state.items.find((item) => item.id === first.id)?.default_model_id).toBe('first-model');
    expect(state.items.find((item) => item.id === second.id)?.default_model_id).toBe(
      'second-model',
    );
    expect(state.default_selection).toEqual({ provider_id: second.id, model_id: 'second-model' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await resolveSelection(client, account)).toMatchObject({
        provider_id: second.id,
        model_id: 'second-model',
      });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await setProviderDefault(pool, account, first.id, null);
    state = await listProviders(pool, account);
    expect(state.items.find((item) => item.id === first.id)?.default_model_id).toBeNull();
    expect(state.items.find((item) => item.id === second.id)?.default_model_id).toBe(
      'second-model',
    );
    expect(state.default_selection).toEqual({ provider_id: second.id, model_id: 'second-model' });
    await setProviderDefault(pool, account, second.id, null);
    state = await listProviders(pool, account);
    expect(state.items.find((item) => item.id === second.id)?.default_model_id).toBeNull();
    expect(state.default_selection).toBeNull();

    await setDefault(pool, account, { provider_id: first.id, model_id: 'first-model' });
    state = await listProviders(pool, account);
    expect(state.items.find((item) => item.id === first.id)?.default_model_id).toBe('first-model');
    expect(state.default_selection).toEqual({ provider_id: first.id, model_id: 'first-model' });
    await setDefault(pool, account, null);
    state = await listProviders(pool, account);
    expect(state.default_selection).toBeNull();
    expect(state.items.find((item) => item.id === first.id)?.default_model_id).toBe('first-model');
  });
  test('provider defaults reject unavailable selections without requiring a key', async () => {
    const account = randomUUID();
    const first = await createProvider(pool, account, 'First validation');
    const second = await createProvider(pool, account, 'Second validation');
    await addModel(pool, account, first.id, 'first-model');
    await addModel(pool, account, second.id, 'second-model');
    await expect(setProviderDefault(pool, account, first.id, 'first-model')).rejects.toThrow();
    await updateProvider(pool, account, first.id, {
      base_url: 'https://first.test/v1',
      enabled: false,
    });
    await expect(setProviderDefault(pool, account, first.id, 'first-model')).rejects.toThrow();
    await updateProvider(pool, account, first.id, { enabled: true });
    await expect(setProviderDefault(pool, account, first.id, 'second-model')).rejects.toThrow();
    await expect(setProviderDefault(pool, randomUUID(), first.id, 'first-model')).rejects.toThrow();
    expect((await setProviderDefault(pool, account, first.id, 'first-model')).has_api_key).toBe(
      false,
    );
    expect((await listProviders(pool, account)).default_selection).toEqual({
      provider_id: first.id,
      model_id: 'first-model',
    });
  });
  test('removing a model or provider cleans its defaults without disturbing another provider', async () => {
    const account = randomUUID();
    const first = await createProvider(pool, account, 'First deletion');
    const second = await createProvider(pool, account, 'Second deletion');
    for (const provider of [first, second]) {
      await updateProvider(pool, account, provider.id, { base_url: 'https://example.test/v1' });
      await addModel(pool, account, provider.id, 'shared-model');
      await setProviderDefault(pool, account, provider.id, 'shared-model');
    }
    await removeModel(pool, account, first.id, 'shared-model');
    let state = await listProviders(pool, account);
    expect(state.items.find((item) => item.id === first.id)?.default_model_id).toBeNull();
    expect(state.items.find((item) => item.id === second.id)?.default_model_id).toBe(
      'shared-model',
    );
    expect(state.default_selection).toEqual({ provider_id: second.id, model_id: 'shared-model' });
    await deleteProvider(pool, account, first.id);
    state = await listProviders(pool, account);
    expect(state.default_selection).toEqual({ provider_id: second.id, model_id: 'shared-model' });
    await deleteProvider(pool, account, second.id);
    state = await listProviders(pool, account);
    expect(state.default_selection).toBeNull();
    expect(state.items.find((item) => item.id === second.id)).toBeUndefined();
    expect(
      (await pool.query('SELECT default_model_id FROM model_providers WHERE id = $1', [second.id]))
        .rows[0].default_model_id,
    ).toBeNull();
  });
  test('deletion during synchronization is reported as a version conflict', async () => {
    const provider = await createProvider(pool, owner, 'Sync race');
    await updateProvider(pool, owner, provider.id, { base_url: 'https://example.test/v1' });
    const request = async () => {
      await deleteProvider(pool, owner, provider.id);
      return { data: [{ id: 'vendor/model' }] };
    };
    try {
      await syncModels(pool, owner, provider.id, request);
      throw new Error('expected conflict');
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      expect(httpStatusForError(error.code)).toBe(409);
    }
  });
  test('sync merges unique models and retains manual models on failure', async () => {
    const provider = await createProvider(pool, owner, 'Sync');
    await updateProvider(pool, owner, provider.id, { base_url: 'https://example.test/v1' });
    await addModel(pool, owner, provider.id, 'manual/model', 8192);
    const result = await syncModels(pool, owner, provider.id, async () => ({
      data: [{ id: 'remote/model' }, { id: 'remote/model' }, { id: 'manual/model' }],
    }));
    expect(result.added_model_ids).toEqual(['remote/model']);
    expect(result.provider.models).toEqual(['manual/model', 'remote/model']);
    expect(result.provider.model_context_windows).toEqual({
      'manual/model': 8192,
      'remote/model': null,
    });
    await expect(
      syncModels(pool, owner, provider.id, async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow();
    expect(
      (await listProviders(pool, owner)).items.find((item) => item.id === provider.id)?.models,
    ).toEqual(['manual/model', 'remote/model']);
  });
  test('synchronizes through the real outbound path to an explicitly allowed local service', async () => {
    let receivedPath = '';
    let receivedAuthorization = '';
    const server = createServer((req, res) => {
      receivedPath = req.url ?? '';
      receivedAuthorization = req.headers.authorization ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'provider/model' }, { id: 'provider/model' }] }));
    });
    const started = Promise.withResolvers<void>();
    server.listen(0, '127.0.0.1', started.resolve);
    await started.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server address unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const previous = process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS;
    try {
      process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = origin;
      const provider = await createProvider(pool, owner, 'Local simulation');
      await updateProvider(pool, owner, provider.id, {
        base_url: `${origin}/v1`,
        credential: { action: 'replace', api_key: 'test-only-key' },
      });
      await addModel(pool, owner, provider.id, 'manual/model');
      const result = await syncModels(pool, owner, provider.id);
      expect(result.provider.models).toEqual(['manual/model', 'provider/model']);
      expect(result.added_model_ids).toEqual(['provider/model']);
      expect(receivedPath).toBe('/v1/models');
      expect(receivedAuthorization).toBe('Bearer test-only-key');
      expect(JSON.stringify(result)).not.toContain('test-only-key');
    } finally {
      if (previous === undefined) delete process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS;
      else process.env.MODEL_PROVIDER_ALLOWED_LOCAL_ORIGINS = previous;
      const stopped = Promise.withResolvers<void>();
      server.close((error) => (error ? stopped.reject(error) : stopped.resolve()));
      await stopped.promise;
    }
  });
  test('run binding freezes configuration and display, then explicit clear revokes it', async () => {
    const provider = await createProvider(pool, owner, 'Original');
    await updateProvider(pool, owner, provider.id, {
      base_url: 'https://example.test/v1',
      credential: { action: 'replace', api_key: 'first-key' },
    });
    await addModel(pool, owner, provider.id, 'vendor/model', 16384);
    const runId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO agent_runs(id, owner_id) VALUES ($1, $2)', [runId, owner]);
      const selected = await resolveSelection(client, owner, {
        provider_id: provider.id,
        model_id: 'vendor/model',
      });
      await bindRunSelection(client, owner, runId, selected);
      await client.query('COMMIT');
      await setModelContextWindow(pool, owner, provider.id, 'vendor/model', 32768);
      await updateProvider(pool, owner, provider.id, {
        name: 'Renamed',
        credential: { action: 'replace', api_key: 'second-key' },
      });
      expect(await resolveRunSelection(client, owner, runId)).toEqual({
        base_url: 'https://example.test/v1',
        api_key: 'first-key',
        model_id: 'vendor/model',
        context_window_tokens: 16384,
      });
      expect((await getRunSelections(client, owner, [runId])).get(runId)).toEqual({
        state: 'available',
        provider_id: provider.id,
        provider_name: 'Original',
        model_id: 'vendor/model',
      });
      await updateProvider(pool, owner, provider.id, { credential: { action: 'clear' } });
      await expect(resolveRunSelection(client, owner, runId)).rejects.toThrow();
      expect((await getRunSelections(client, owner, [runId])).get(runId)?.provider_name).toBe(
        'Original',
      );
    } finally {
      client.release();
    }
  });
});
