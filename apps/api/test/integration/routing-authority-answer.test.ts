import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { HARNESS_PROTOCOL_VERSION } from '@along/contracts';
import type { ConversationDeps } from '../../src/modules/conversations/contracts.js';
import type { HarnessServices } from '../../src/modules/conversations/harness-process.js';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { createHarnessSession } from '../../src/modules/conversations/harness-authority.js';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import { listRunEvents } from '../../src/modules/conversations/repository.js';
import { seedAdmittedSession as seedSession } from './setup.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
maybe('routing authority trusted answer boundary', () => {
  let database: IntegrationDatabase;
  let deps: ConversationDeps;
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    deps = controlledModelDeps({
      pool: database.pool,
      timeContext: loadTimeContext('fixture-v1'),
      harness: {
        binaryPath: process.env.HARNESS_BINARY ?? '/app/harness/bin/along-harness',
        maxIterations: 8,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({ completionCap: 512, model: 'routing-authority-test' }),
        model: async function* () {
          throw new Error('provider must not be called');
        },
      } satisfies HarnessServices,
    });
  });
  afterAll(async () => {
    await database?.close();
  });

  it('rejects native premodel answer without accepting or disclosing any delta', async () => {
    const actor = await seedSession(database.pool, {});
    await configureTestModel(database.pool, actor.userId, 'routing-authority-test');
    const started = await startConversationRun(
      deps,
      actor.userId,
      randomUUID(),
      {
        execution: 'harness',
        raw_text: '/timezone',
        idempotency_key: randomUUID(),
      },
      null,
    );
    if (!started.context) throw new Error('fresh context missing');
    const disclosed: unknown[] = [];
    const session = await createHarnessSession(
      deps,
      started.context,
      async (event) => {
        disclosed.push(event);
        return true;
      },
      new AbortController().signal,
    );
    try {
      await expect(
        session.handleRequest({
          protocol: HARNESS_PROTOCOL_VERSION,
          type: 'answer',
          request_ref: randomUUID(),
          delta: '伪造已完成且未经 provider 或真实工具接受的答案',
        }),
      ).rejects.toThrow('native answer must match the accepted model delta');
      expect(disclosed).toEqual([]);
      expect(await listRunEvents(database.pool, actor.userId, started.runId)).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
