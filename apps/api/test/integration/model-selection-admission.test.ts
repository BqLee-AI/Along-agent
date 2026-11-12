import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import type { ConversationDeps } from '../../src/modules/conversations/contracts.js';
import type { HarnessServices } from '../../src/modules/conversations/harness-process.js';
import { getRunView } from '../../src/modules/conversations/harness-authority.js';
import { getConversationRuns } from '../../src/modules/conversations/history-service.js';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import {
  addModel,
  createProvider,
  deleteProvider,
  listProviders,
  setDefault,
  updateProvider,
} from '../../src/modules/model-providers/service.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { controlledModelDeps } from '../helpers/model-selection.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const suite = databaseUrl ? describe : describe.skip;
suite('model selection admission and historical projection', () => {
  let db: IntegrationDatabase;
  let deps: ConversationDeps;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
    deps = controlledModelDeps({
      pool: db.pool,
      timeContext: loadTimeContext('fixture-v1'),
      harness: {
        binaryPath: '/unused',
        maxIterations: 8,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({ completionCap: 512, model: 'deployment-model' }),
        model: async function* () {
          throw new Error('deployment transport must never be called');
        },
      } satisfies HarnessServices,
    });
  });
  afterAll(async () => {
    await db?.close();
  });

  test('concurrent same-key admission, intent conflicts, deletion replay and frozen history', async () => {
    const owner = await seedAdmittedSession(db.pool);
    const other = await seedAdmittedSession(db.pool);
    const provider = await createProvider(db.pool, owner.userId, 'Original name');
    await updateProvider(db.pool, owner.userId, provider.id, {
      base_url: 'https://example.test/v1',
    });
    await addModel(db.pool, owner.userId, provider.id, 'vendor/model');
    const selection = { provider_id: provider.id, model_id: 'vendor/model' };
    await setDefault(db.pool, owner.userId, selection);
    const key = randomUUID();
    const body = { execution: 'harness', raw_text: 'hello' };
    const start = (request: unknown) =>
      startConversationRun(deps, owner.userId, randomUUID(), request, key);
    const [a, b] = await Promise.all([start(body), start(body)]);
    expect(a.runId).toBe(b.runId);
    expect([a, b].filter((result) => result.context !== null)).toHaveLength(1);
    await expect(start({ ...body, model_selection: selection })).rejects.toMatchObject({
      httpStatus: 409,
    });
    await updateProvider(db.pool, owner.userId, provider.id, { name: 'Renamed' });
    await deleteProvider(db.pool, owner.userId, provider.id);
    const replay = await start(body);
    expect(replay.runId).toBe(a.runId);
    expect(replay.replay).not.toBeNull();
    const expected = {
      state: 'available' as const,
      provider_id: provider.id,
      provider_name: 'Original name',
      model_id: 'vendor/model',
    };
    expect(
      (await getRunView(deps, owner.userId, a.conversationId, a.runId)).model_selection,
    ).toEqual(expected);
    const business = await startConversationRun(
      deps,
      owner.userId,
      randomUUID(),
      { raw_text: 'ordinary business request' },
      randomUUID(),
    );
    expect(
      (await getRunView(deps, owner.userId, business.conversationId, business.runId))
        .model_selection,
    ).toEqual({ state: 'not_applicable' });
    const history = await getConversationRuns(deps, owner.userId, a.conversationId, {});
    expect(history.items[0]?.model_selection).toEqual(expected);
    await expect(getRunView(deps, other.userId, a.conversationId, a.runId)).rejects.toThrow();
    await expect(
      startConversationRun(
        deps,
        owner.userId,
        randomUUID(),
        { ...body, model_selection: selection },
        randomUUID(),
      ),
    ).rejects.toThrow();
  });

  test('offline import targets only the specified active owner and does not select a default', async () => {
    const owner = await seedAdmittedSession(db.pool);
    const other = await seedAdmittedSession(db.pool);
    const key = Buffer.alloc(32, 9).toString('base64');
    const proc = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        fileURLToPath(new URL('../../src/bin/import-model-provider.ts', import.meta.url)),
        owner.userId,
      ],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          DATABASE_URL: db.connectionString,
          MODEL_PROVIDER_ENCRYPTION_KEY: key,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      },
    );
    proc.stdin.write(
      JSON.stringify({
        name: 'Imported',
        base_url: 'https://example.test/v1',
        api_key: 'test-only-key',
        model_id: 'old/model',
      }),
    );
    proc.stdin.end();
    const [exit, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exit).toBe(0);
    expect(stdout + stderr).not.toContain('test-only-key');
    const imported = await listProviders(db.pool, owner.userId);
    expect(imported.items.map((item) => item.models)).toEqual([['old/model']]);
    expect(imported.default_selection).toBeNull();
    expect((await listProviders(db.pool, other.userId)).items).toEqual([]);
  });
});
