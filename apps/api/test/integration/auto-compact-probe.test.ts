import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { HARNESS_CONTEXT_PROTOCOL_VERSION, type HarnessRequest } from '@along/contracts';
import { withTransaction } from '../../src/db/transaction.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { createHarnessSession } from '../../src/agent/runtime/attempt-session.js';
import { freezeR3Context } from '../../src/features/conversations/compact/r3-context.js';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

// The meter and calibration below are deliberately injected test facts. They
// do not imply that the deployment adapter has a verified input meter.
const model = 'auto-compact-test';
const policy = {
  evidenceId: 'isolated-test-only',
  model,
  adapterRevision: 'openai-chat/v1',
  meterRevision: 'fixture-meter/1',
  windowTokens: 10000,
  triggerRatio: 0.8,
  compactInputTokens: 1000,
  continuationTokens: 512,
  continuationIterations: 1,
};
const contextPolicy = createContextPolicy({
  model,
  completionCap: 512,
  modelWindowTokens: 10000,
  inputMeter: 'verified',
  meterRevision: 'fixture-meter/1',
  reserveTokens: 128,
});
const frame = <T extends HarnessRequest['type']>(
  type: T,
  value: Omit<Extract<HarnessRequest, { type: T }>, 'type' | 'protocol' | 'request_ref'>,
) =>
  ({
    protocol: HARNESS_CONTEXT_PROTOCOL_VERSION,
    request_ref: randomUUID(),
    type,
    ...value,
  }) as Extract<HarnessRequest, { type: T }>;

(databaseUrl ? describe : describe.skip)('automatic compact final measurement authority', () => {
  let db: IntegrationDatabase;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  async function fixture(
    options: {
      configured?: boolean;
      verified?: boolean;
      previousCoverage?: boolean;
      inputTokens?: number;
    } = {},
  ) {
    const actor = await seedAdmittedSession(db.pool);
    await configureTestModel(db.pool, actor.userId, model);
    const conversationId = randomUUID();
    await db.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      conversationId,
      actor.userId,
    ]);
    await db.pool.query(
      `INSERT INTO messages(id,owner_id,conversation_id,role,content,created_at)
      VALUES($1,$2,$3,'user','previous source','2020-01-01')`,
      [randomUUID(), actor.userId, conversationId],
    );
    let modelCalls = 0,
      measurementCalls = 0;
    const deps = controlledModelDeps({
      pool: db.pool,
      timeContext: loadTimeContext('fixture-v1'),
      harness: {
        binaryPath: '/unused',
        maxIterations: 8,
        maxTokens: 8000,
        contextPolicy,
        // oxlint-disable-next-line require-yield -- Failure-only provider intentionally emits no events.
        model: async function* () {
          modelCalls++;
          throw new Error('unexpected model call');
        },
        measure: async () => {
          measurementCalls++;
          return {
            wire_bytes: 1000,
            http_bytes: 1000,
            input_meter: {
              quality:
                options.verified === false ? ('unavailable' as const) : ('verified' as const),
              input_tokens: options.verified === false ? null : (options.inputTokens ?? 8000),
              meter_revision: 'fixture-meter/1',
            },
            output_ceiling: 512,
            limit_reason: null,
          };
        },
      },
    });
    const original = await startConversationRun(
      deps,
      actor.userId,
      randomUUID(),
      {
        conversation_id: conversationId,
        execution: 'harness',
        raw_text: 'current input',
      },
      randomUUID(),
    );
    if (!original.context?.userMessageId) throw new Error('missing original input');
    const runId = randomUUID(),
      attemptId = randomUUID();
    const binding = {
      ...original.context,
      userMessageId: original.context.userMessageId,
      runId,
      attemptId,
      executionProfile: 'compact-memory/1' as const,
    };
    const r3 = await withTransaction(db.pool, async (client) => {
      await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [conversationId]);
      await client.query(
        `INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
        SELECT $2,owner_id,conversation_id,agent_revision,mode,'running',budget_max_iterations,budget_max_tokens,execution,tools_allowlist,
        frozen_context || $3::jsonb,input_message_id FROM agent_runs WHERE id=$1`,
        [
          original.runId,
          runId,
          JSON.stringify({
            execution_profile: 'compact-memory/1',
            ...(options.configured === false ? {} : { autoCompactPolicy: policy }),
          }),
        ],
      );
      await client.query(
        `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status) VALUES($1,$2,$3,1,'running')`,
        [attemptId, actor.userId, runId],
      );
      await client.query(
        `INSERT INTO run_context_policies(run_id,owner_id,policy,policy_hash)
        SELECT $2,owner_id,policy,policy_hash FROM run_context_policies WHERE run_id=$1`,
        [original.runId, runId],
      );
      await client.query(
        `INSERT INTO model_provider_run_bindings(run_id,owner_id,version_id,provider_id,provider_name,model_id)
        SELECT $2,owner_id,version_id,provider_id,provider_name,model_id FROM model_provider_run_bindings WHERE run_id=$1`,
        [original.runId, runId],
      );
      const frozen = await freezeR3Context(client, {
        ownerId: actor.userId,
        conversationId,
        runId,
        userMessageId: binding.userMessageId,
      });
      if (options.previousCoverage) {
        await client.query(
          `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state,snapshot)
          VALUES($1,$2,$3,$4,$5,$6,'runtime','automatic_compact','runtime','invalidated',$7::jsonb)`,
          [
            randomUUID(),
            actor.userId,
            conversationId,
            runId,
            attemptId,
            randomUUID(),
            JSON.stringify({ context: frozen }),
          ],
        );
      }
      return frozen;
    });
    const session = await createHarnessSession(
      deps,
      binding,
      async () => true,
      new AbortController().signal,
    );
    const measure = () =>
      session.handleRequest(
        frame('measure_context', {
          messages: [{ role: 'user', content: 'current input' }],
          remaining_tokens: 8000,
          max_output_tokens: 512,
        }),
      );
    const probe = (final = false) =>
      session.handleRequest(frame('pause_probe', final ? { after_measurement: true } : {}));
    const operations = async () =>
      (
        await db.pool.query(
          `SELECT p.state,p.purpose,o.status
      FROM harness_pauses p LEFT JOIN compact_operations o ON o.pause_id=p.id
      WHERE p.run_id=$1 ORDER BY p.created_at,p.id`,
          [runId],
        )
      ).rows;
    return {
      session,
      r3,
      measure,
      probe,
      operations,
      runId,
      actor,
      counts: () => ({ modelCalls, measurementCalls }),
    };
  }

  it('creates one durable pause at the 80% threshold and revokes the model permit', async () => {
    const f = await fixture();
    try {
      expect(await f.probe()).toEqual({ pending: false });
      await f.measure();
      expect(await f.probe(true)).toEqual({ pending: true });
      expect(await f.operations()).toEqual([
        { state: 'pending', purpose: 'automatic_compact', status: 'pending' },
      ]);
      await expect(
        f.session.handleRequest(
          frame('model', {
            messages: [{ role: 'user', content: 'current input' }],
            remaining_tokens: 8000,
            max_output_tokens: 512,
          }),
        ),
      ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
      expect(await f.probe(true)).toEqual({ pending: true });
      expect(await f.operations()).toHaveLength(1);
      expect(f.counts()).toEqual({ modelCalls: 0, measurementCalls: 1 });
    } finally {
      await f.session.close();
    }
  });

  it('does not compact just below the 80% threshold', async () => {
    const f = await fixture({ inputTokens: 7999 });
    try {
      expect(await f.probe()).toEqual({ pending: false });
      await f.measure();
      expect(await f.probe(true)).toEqual({ pending: false });
      expect(await f.operations()).toEqual([]);
      expect(f.counts()).toEqual({ modelCalls: 0, measurementCalls: 1 });
    } finally {
      await f.session.close();
    }
  });

  it('does not trigger without a final marker, a fresh measurement, or a prior safe-point permit', async () => {
    const f = await fixture();
    try {
      await f.measure();
      expect(await f.probe(true)).toEqual({ pending: false });
      expect(await f.probe(true)).toEqual({ pending: false });
      await f.measure();
      expect(await f.probe()).toEqual({ pending: false });
      expect(await f.probe(true)).toEqual({ pending: false });
      expect(await f.operations()).toEqual([]);
      expect(f.counts().modelCalls).toBe(0);
    } finally {
      await f.session.close();
    }
  });

  for (const options of [{ configured: false }, { verified: false }, { previousCoverage: true }]) {
    it(`does not auto-compact with ${Object.keys(options)[0]}`, async () => {
      const f = await fixture(options);
      try {
        expect(await f.probe()).toEqual({ pending: false });
        await f.measure();
        expect(await f.probe(true)).toEqual({ pending: false });
        const rows = await f.operations();
        expect(rows.filter((row) => row.state === 'pending')).toHaveLength(0);
        expect(rows).toHaveLength(options.previousCoverage ? 1 : 0);
        expect(f.counts().modelCalls).toBe(0);
      } finally {
        await f.session.close();
      }
    });
  }
});
