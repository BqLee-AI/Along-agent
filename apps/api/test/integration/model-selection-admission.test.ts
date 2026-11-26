import { expectApplicationRejection } from '../helpers/application-error.js';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createBotConversation,
  createContextPolicy,
} from '../../src/features/conversations/public.js';
import { createPersonalBot, updatePersonalBot } from '../../src/features/bots/public.js';
import type { ConversationDeps } from '../../src/agent/execution/contracts.js';
import type { HarnessServices } from '../../src/agent/execution/contracts.js';
import { getRunView } from '../../src/agent/run/run-actions.js';
import { getConversationRuns } from '../../src/features/conversations/history/history-service.js';
import { startConversationRun } from '../../src/agent/run/admit-message.js';
import {
  addModel,
  createProvider,
  deleteProvider,
  listProviders,
  setDefault,
  updateProvider,
} from '../../src/features/model-providers/configuration/service.js';
import { loadTimeContext } from '../../src/features/time/context.js';
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
        // oxlint-disable-next-line require-yield -- Failure-only provider intentionally emits no events.
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
    const actor = {
      ownerId: owner.userId,
      sessionId: owner.sessionId,
      displayName: 'Researcher',
      timezoneId: null,
    };
    const config = {
      name: 'Research',
      introduction: '',
      role: 'reviewer',
      instructions: 'Check sources.',
      model_selection: null,
      tool_ids: ['list_tasks'],
      workspace_ids: [],
    };
    const bot = await createPersonalBot(db.pool, actor, config);
    const { conversation_id } = await createBotConversation(db.pool, actor, bot.id, randomUUID());
    const key = randomUUID();
    const body = { conversation_id, execution: 'harness', raw_text: 'hello' };
    const start = (request: unknown) =>
      startConversationRun(deps, owner.userId, randomUUID(), request, key);
    const [a, b] = await Promise.all([start(body), start(body)]);
    expect(a.runId).toBe(b.runId);
    expect([a, b].filter((result) => result.context !== null)).toHaveLength(1);
    expect((a.context ?? b.context)?.personalBot).toEqual({
      id: bot.id,
      revision: bot.revision,
      role: 'reviewer',
      instructions: 'Check sources.',
    });
    expect((a.context ?? b.context)?.allowlist).toEqual(['list_tasks']);
    await expectApplicationRejection(start({ ...body, model_selection: selection }), {
      status: 409,
    });
    await updateProvider(db.pool, owner.userId, provider.id, { name: 'Renamed' });
    const edited = await updatePersonalBot(db.pool, actor, bot.id, bot.revision, {
      ...config,
      role: 'editor',
      instructions: 'Check names.',
      tool_ids: [],
    });
    const following = await startConversationRun(
      deps,
      owner.userId,
      randomUUID(),
      body,
      randomUUID(),
    );
    expect(following.context?.personalBot?.revision).toBe(edited.revision);
    expect(following.context?.personalBot?.role).toBe('editor');
    expect(following.context?.allowlist).toEqual([]);
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
      { conversation_id, raw_text: 'ordinary business request' },
      randomUUID(),
    );
    expect(
      (await getRunView(deps, owner.userId, business.conversationId, business.runId))
        .model_selection,
    ).toEqual({ state: 'not_applicable' });
    const history = await getConversationRuns(deps, owner.userId, a.conversationId, {});
    expect(history.items.find((item) => item.run_id === a.runId)?.model_selection).toEqual(
      expected,
    );
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
