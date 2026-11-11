import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import {
  createProvider,
  updateProvider,
  addModel,
  removeModel,
  setDefault,
  listProviders,
  deleteProvider,
  syncModels,
  resolveSelection,
  bindRunSelection,
  resolveRunSelection,
  getRunSelections,
} from '../../src/modules/model-providers/service.js';

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
    await pool.query(await readFile('infra/migrations/0028_model_providers.sql', 'utf8'));
  });
  afterAll(async () => {
    delete process.env.MODEL_PROVIDER_ENCRYPTION_KEY;
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  test('credentials are private and endpoint changes require explicit credential action', async () => {
    const provider = await createProvider(pool, owner, 'Example');
    await updateProvider(pool, owner, provider.id, {
      base_url: 'https://example.test/v1',
      credential: { action: 'replace', api_key: 'secret' },
    });
    const view = await listProviders(pool, owner);
    expect(JSON.stringify(view)).not.toContain('secret');
    expect(view.items[0]?.has_api_key).toBe(true);
    await expect(
      updateProvider(pool, owner, provider.id, { base_url: 'https://other.test/v1' }),
    ).rejects.toThrow();
    await expect(updateProvider(pool, other, provider.id, { name: 'stolen' })).rejects.toThrow();
    await updateProvider(pool, owner, provider.id, {
      base_url: 'https://other.test/v1',
      credential: { action: 'clear' },
    });
    expect((await listProviders(pool, owner)).items[0]?.has_api_key).toBe(false);
  });
  test('removing the selected model clears the default', async () => {
    const provider = await createProvider(pool, owner, 'Selection');
    await addModel(pool, owner, provider.id, 'vendor/model');
    await setDefault(pool, owner, { provider_id: provider.id, model_id: 'vendor/model' });
    await removeModel(pool, owner, provider.id, 'vendor/model');
    expect((await listProviders(pool, owner)).default_selection).toBeNull();
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
      expect((error as { httpStatus: number }).httpStatus).toBe(409);
    }
  });
  test('sync merges unique models and retains manual models on failure', async () => {
    const provider = await createProvider(pool, owner, 'Sync');
    await updateProvider(pool, owner, provider.id, { base_url: 'https://example.test/v1' });
    await addModel(pool, owner, provider.id, 'manual/model');
    const result = await syncModels(pool, owner, provider.id, async () => ({
      data: [{ id: 'remote/model' }, { id: 'remote/model' }],
    }));
    expect(result.added_model_ids).toEqual(['remote/model']);
    expect(result.provider.models).toEqual(['manual/model', 'remote/model']);
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
    await addModel(pool, owner, provider.id, 'vendor/model');
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
      await updateProvider(pool, owner, provider.id, {
        name: 'Renamed',
        credential: { action: 'replace', api_key: 'second-key' },
      });
      expect(await resolveRunSelection(client, owner, runId)).toEqual({
        base_url: 'https://example.test/v1',
        api_key: 'first-key',
        model_id: 'vendor/model',
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
