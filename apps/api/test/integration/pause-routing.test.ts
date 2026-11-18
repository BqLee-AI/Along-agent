import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  HARNESS_R3_PROTOCOL_VERSION,
  RoutingDecisionReplySchema,
  RoutingFactsSchema,
  type HarnessRequest,
} from '@along/contracts';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { getRunView } from '../../src/agent/operations/run.js';
import { createHarnessSession } from '../../src/agent/runtime/attempt-session.js';
import { requestConversationPause } from '../../src/agent/operations/pause.js';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { routingHash } from '../../src/agent/routing/routing-checkpoints.js';
import {
  createRoutingRuntime,
  type EnabledRoutingPolicy,
  type RoutingRuntime,
} from '../../src/agent/routing/index.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

(databaseUrl ? describe : describe.skip)('pause during direct routing', () => {
  let db: IntegrationDatabase;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  it('completes the already permitted direct unit and invalidates the pending pause', async () => {
    const actor = await seedAdmittedSession(db.pool, { timezoneId: 'Asia/Tokyo' });
    await configureTestModel(db.pool, actor.userId, 'routing-pause');
    const policy: EnabledRoutingPolicy = {
      revision: 'r2b/1',
      mode: 'enforce',
      bundle_sha256: 'a'.repeat(64),
      encoding_sha256: 'b'.repeat(64),
      candidate_intents: ['prefs_timezone_read', 'task_list_bounded', 'brief_cards_read'],
      direct_intents: ['prefs_timezone_read', 'task_list_bounded', 'brief_cards_read'],
      thresholds: {
        prefs_timezone_read: { tau_intent: 0.8, tau_gap: 0.1 },
        task_list_bounded: { tau_intent: 0.8, tau_gap: 0.1 },
        brief_cards_read: { tau_intent: 0.8, tau_gap: 0.1 },
      },
      competition: ['prefs_timezone_read', 'task_list_bounded', 'brief_cards_read', 'other'],
      deadline_ms: 1000,
      max_inflight: 2,
      guard_revision: 'test-guard/1',
      parser_revision: 'test-parser/1',
      handler_revision: 'test-handler/1',
      renderer_revision: 'test-renderer/1',
      scorer_revision: 'test-scorer/1',
    };
    const renderer = createRoutingRuntime({ mode: 'off' });
    const routing: RoutingRuntime = {
      policy: () => policy,
      facts: (input) => ({
        facts_ref: randomUUID(),
        input_sha256: routingHash(input.text),
        bundle_sha256: policy.bundle_sha256,
        eligible: true,
        reason: null,
        rule_intent: 'prefs_timezone_read',
        candidates: [
          { intent: 'prefs_timezone_read', tool_id: 'get_user_prefs', args: {}, sources: [] },
        ],
      }),
      embedding: async () => {
        throw new Error('unexpected embedding');
      },
      choose: () => 'prefs_timezone_read',
      render: (intent, result) => renderer.render(intent, result),
    };
    const deps = controlledModelDeps({
      pool: db.pool,
      timeContext: loadTimeContext('fixture-v1'),
      routing,
      harness: {
        binaryPath: '/unused',
        maxIterations: 8,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({ completionCap: 512, model: 'routing-pause' }),
        // oxlint-disable-next-line require-yield -- Failure-only provider intentionally emits no events.
        model: async function* () {
          throw new Error('unexpected model');
        },
      },
    });
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
    if (!started.context) throw new Error('missing context');
    const context = started.context;
    const session = await createHarnessSession(
      deps,
      context,
      async () => true,
      new AbortController().signal,
    );
    const request = <T extends HarnessRequest['type']>(
      type: T,
      value: Omit<Extract<HarnessRequest, { type: T }>, 'type' | 'protocol' | 'request_ref'>,
    ) =>
      ({
        protocol: HARNESS_R3_PROTOCOL_VERSION,
        request_ref: randomUUID(),
        type,
        ...value,
      }) as Extract<HarnessRequest, { type: T }>;
    try {
      expect(session.start.eligible_phase).toBe('fresh_first_step');
      expect(await session.handleRequest(request('pause_probe', {}))).toEqual({ pending: false });
      const facts = RoutingFactsSchema.parse(
        await session.handleRequest(request('route_probe', { stage: 'facts', facts_ref: null })),
      );
      const decision = RoutingDecisionReplySchema.parse(
        await session.handleRequest(
          request('route_decide', {
            decision: 'direct',
            facts_ref: facts.facts_ref,
            candidate_intent: 'prefs_timezone_read',
            reason: 'rule_match',
          }),
        ),
      );
      const toolId = decision.tool_id!,
        args = decision.args!;
      const reserved = (await session.handleRequest(
        request('reserve', { call_key: 'harness/1', tool_id: toolId, args }),
      )) as { invocation_id: string };
      expect(reserved).toEqual({ invocation_id: expect.any(String) });
      const pause = await requestConversationPause(
        deps,
        actor.userId,
        context.conversationId,
        context.runId,
        { reason: 'user', purpose: 'none' },
        randomUUID(),
      );
      expect(pause.status).toBe('pending');
      await session.handleRequest(
        request('invoke', { invocation_id: reserved.invocation_id, tool_id: toolId, args }),
      );
      await session.handleRequest(
        request('snapshot', {
          context: {
            version: 2,
            message_refs: [context.userMessageId!],
            tool_refs: [reserved.invocation_id],
            next_call_no: 2,
            usage: { iterations: 0, tokens: 0 },
            waiting: null,
          },
        }),
      );
      await session.handleRequest(
        request('render_route_result', {
          decision_ref: decision.decision_ref,
          invocation_ref: reserved.invocation_id,
          template_revision: 'test-renderer/1',
        }),
      );
      await session.handleRequest(
        request('finish', { outcome: 'done', usage: { iterations: 0, tokens: 0 } }),
      );
      expect(
        (await getRunView(deps, actor.userId, context.conversationId, context.runId)).status,
      ).toBe('done');
      expect(
        (await db.pool.query('SELECT state FROM harness_pauses WHERE id=$1', [pause.pause_id]))
          .rows[0]?.state,
      ).toBe('invalidated');
    } finally {
      await session.close();
    }
  });
});
