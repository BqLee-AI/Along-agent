import { createFixtureConversation } from '../helpers/bot-conversation.js';
import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  HARNESS_R3_PROTOCOL_VERSION,
  RoutingFactsSchema,
  RoutingDecisionReplySchema,
  type HarnessRequest,
  type HarnessStart,
  type RoutingPolicy,
  type RoutingFacts,
  type RoutingEmbedding,
  type RoutingDecisionReply,
} from '@along/contracts';
import type { ThreadEvent } from '@along/stream-protocol';
import { withTransaction } from '../../src/db/transaction.js';
import type {
  ConversationDeps,
  RunContext,
  StartResult,
} from '../../src/agent/execution/contracts.js';
import type { HarnessServices } from '../../src/agent/execution/contracts.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { cancelConversationRun, getRunView } from '../../src/agent/run/run-actions.js';
import { requestConversationPause, continueConversationPause } from '../../src/agent/run/pause.js';
import {
  createHarnessSession,
  type HarnessSession,
} from '../../src/agent/execution/attempt/session.js';
import { startConversationRun } from '../../src/agent/run/admit-message.js';
import {
  insertRoutingPolicy,
  readRoutingPolicy,
  routingHash,
  decisionPayload,
  acceptRoutingDecision,
} from '../../src/agent/routing/routing-checkpoints.js';
import {
  listRunEvents,
  listConversationEvents,
} from '../../src/features/conversations/run/checkpoints.js';
import { lockRun } from '../../src/features/conversations/run/repository.js';
import {
  createRoutingRuntime,
  type RoutingRuntime,
  type EnabledRoutingPolicy,
} from '../../src/agent/routing/index.js';
import { seedAdmittedSession as seedSession } from './setup.js';
import type { SeededSession } from '../../src/features/identity/session/seed.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
function request<T extends HarnessRequest['type']>(
  type: T,
  value: Omit<Extract<HarnessRequest, { type: T }>, 'type' | 'protocol' | 'request_ref'>,
): Extract<HarnessRequest, { type: T }> {
  return {
    protocol: HARNESS_R3_PROTOCOL_VERSION,
    request_ref: randomUUID(),
    type,
    ...value,
  } as Extract<HarnessRequest, { type: T }>;
}
const enabled: EnabledRoutingPolicy = {
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

interface Fixture {
  deps: ConversationDeps;
  actor: SeededSession;
  started: StartResult;
  context: RunContext & { userMessageId: string };
  events: ThreadEvent[];
  controller: AbortController;
  session: Omit<HarnessSession, 'start'> & { start: HarnessStart };
  frame: HarnessSession['handleRequest'];
  counts(): { factsCalls: number; embeddingCalls: number; modelCalls: number; renderCalls: number };
  modelInputs: Extract<HarnessRequest, { type: 'model' }>[];
  body: { conversation_id: string; execution: string; raw_text: string; idempotency_key: string };
  key: string;
}
interface AcceptedRoute {
  facts: RoutingFacts;
  receipt: RoutingDecisionReply;
  decisionRequest: Extract<HarnessRequest, { type: 'route_decide' }>;
  invocation: string;
  outcome: unknown;
}
maybe('routing authority durable consumer behavior', () => {
  let database: IntegrationDatabase;
  const pureRenderer = createRoutingRuntime({ mode: 'off' });
  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });

  async function fixture(
    options: {
      mode?: 'off' | 'enforce' | 'shadow';
      text?: string;
      rule?: boolean;
      facts?: (facts: RoutingFacts) => RoutingFacts;
      embedding?: RoutingRuntime['embedding'];
      render?: RoutingRuntime['render'];
    } = {},
  ): Promise<Fixture> {
    let factsCalls = 0,
      embeddingCalls = 0,
      modelCalls = 0,
      renderCalls = 0;
    const modelInputs: Extract<HarnessRequest, { type: 'model' }>[] = [];
    const policy: RoutingPolicy =
      options.mode === 'off'
        ? { revision: 'r2b/1', mode: 'off' }
        : {
            ...enabled,
            mode: options.mode ?? 'enforce',
            direct_intents: options.mode === 'shadow' ? [] : enabled.direct_intents,
          };
    const runtime: RoutingRuntime = {
      policy: () => policy,
      facts: (input) => {
        factsCalls++;
        const result: RoutingFacts = {
          facts_ref: randomUUID(),
          input_sha256: routingHash(input.text),
          bundle_sha256: 'a'.repeat(64),
          eligible: true,
          reason: null,
          rule_intent: options.rule === false ? null : 'prefs_timezone_read',
          candidates: [
            { intent: 'prefs_timezone_read', tool_id: 'get_user_prefs', args: {}, sources: [] },
          ],
        };
        return options.facts?.(result) ?? result;
      },
      embedding: async (...args) => {
        embeddingCalls++;
        if (options.embedding) return options.embedding(...args);
        const facts = args[1];
        return {
          facts_ref: facts.facts_ref,
          input_sha256: facts.input_sha256,
          bundle_sha256: facts.bundle_sha256,
          reason: null,
          scores: [
            { intent: 'prefs_timezone_read', score: 1, exclusion_score: 0 },
            { intent: 'task_list_bounded', score: 0, exclusion_score: 0 },
            { intent: 'brief_cards_read', score: 0, exclusion_score: 0 },
            { intent: 'other', score: 0, exclusion_score: null },
          ],
        };
      },
      choose: (facts, evidence) =>
        facts.eligible
          ? (facts.rule_intent ?? (evidence?.reason === null ? 'prefs_timezone_read' : null))
          : null,
      render: (intent, result) => {
        renderCalls++;
        return options.render?.(intent, result) ?? pureRenderer.render(intent, result);
      },
    };
    const deps: ConversationDeps = controlledModelDeps({
      pool: database.pool,
      timeContext: loadTimeContext('fixture-v1'),
      routing: runtime,
      harness: {
        binaryPath: '/unused-controlled-consumer',
        maxIterations: 8,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({ completionCap: 512, model: 'routing-integration' }),
        model: async function* (modelRequest) {
          modelInputs.push(structuredClone(modelRequest));
          modelCalls++;
          yield { type: 'delta', delta: '原模型回答' };
          yield {
            type: 'complete',
            reply: { message: { content: '原模型回答', tool_calls: [] }, usage: null },
          };
        },
      } satisfies HarnessServices,
    });
    const actor = await seedSession(database.pool, { timezoneId: 'Asia/Tokyo' });
    await configureTestModel(database.pool, actor.userId, 'routing-integration');
    const key = randomUUID();
    const body = {
      conversation_id: await createFixtureConversation(database.pool, actor.userId),
      execution: 'harness',
      raw_text: options.text ?? '/timezone',
      idempotency_key: key,
    };
    const started = await startConversationRun(deps, actor.userId, randomUUID(), body, null);
    if (!started.context?.userMessageId) throw new Error('fresh user context missing');
    const context = { ...started.context, userMessageId: started.context.userMessageId };
    const events: ThreadEvent[] = [];
    const controller = new AbortController();
    const session = await createHarnessSession(
      deps,
      context,
      async (event) => {
        events.push(event);
        return true;
      },
      controller.signal,
    );
    if (session.start.protocol !== HARNESS_R3_PROTOCOL_VERSION)
      throw new Error('v7 harness protocol expected');
    const legacySession = { ...session, start: session.start };
    const probe = async () => {
      expect(await session.handleRequest(request('pause_probe', {}))).toEqual({ pending: false });
    };
    await probe();
    let directRoute = false;
    const frame: HarnessSession['handleRequest'] = async (action) => {
      if (
        !directRoute &&
        (action.type === 'model' ||
          action.type === 'reserve' ||
          action.type === 'finish_goal' ||
          (action.type === 'finish' && action.outcome === 'done'))
      ) {
        await probe();
      }
      const result = await session.handleRequest(action);
      if (action.type === 'route_decide' && action.decision === 'direct') directRoute = true;
      return result;
    };
    const counts = () => ({ factsCalls, embeddingCalls, modelCalls, renderCalls });
    return {
      deps,
      actor,
      started,
      context,
      events,
      controller,
      session: legacySession,
      frame,
      counts,
      body,
      key,
      modelInputs,
    };
  }
  async function decide(f: Fixture) {
    const facts = RoutingFactsSchema.parse(
      await f.frame(request('route_probe', { stage: 'facts', facts_ref: null })),
    );
    const decisionRequest = request('route_decide', {
      decision: 'direct',
      facts_ref: facts.facts_ref,
      candidate_intent: facts.rule_intent ?? 'prefs_timezone_read',
      reason: 'rule_match',
    });
    const receipt = RoutingDecisionReplySchema.parse(await f.frame(decisionRequest));
    return { facts, receipt, decisionRequest };
  }
  async function accepted(f: Fixture): Promise<AcceptedRoute> {
    const decision = await decide(f);
    const toolId = decision.receipt.tool_id!,
      args = decision.receipt.args!;
    const reserved = (await f.frame(
      request('reserve', { call_key: 'harness/1', tool_id: toolId, args }),
    )) as { invocation_id: string };
    const outcome = await f.frame(
      request('invoke', { invocation_id: reserved.invocation_id, tool_id: toolId, args }),
    );
    await f.frame(
      request('snapshot', {
        context: {
          version: 2,
          message_refs: [f.context.userMessageId],
          tool_refs: [reserved.invocation_id],
          next_call_no: 2,
          usage: { iterations: 0, tokens: 0 },
          waiting: null,
        },
      }),
    );
    return { ...decision, invocation: reserved.invocation_id, outcome };
  }
  async function render(f: Fixture, accepted: AcceptedRoute) {
    return f.frame(
      request('render_route_result', {
        decision_ref: accepted.receipt.decision_ref,
        invocation_ref: accepted.invocation,
        template_revision: 'test-renderer/1',
      }),
    );
  }

  it('pause wins before decision, with no direct receipt or tool, and resumes only once', async () => {
    const f = await fixture();
    try {
      const facts = RoutingFactsSchema.parse(
        await f.session.handleRequest(request('route_probe', { stage: 'facts', facts_ref: null })),
      );
      const pause = await requestConversationPause(
        f.deps,
        f.actor.userId,
        f.context.conversationId,
        f.context.runId,
        { reason: 'user', purpose: 'none' },
        randomUUID(),
      );
      expect(
        await f.session.handleRequest(
          request('route_decide', {
            decision: 'direct',
            facts_ref: facts.facts_ref,
            candidate_intent: 'prefs_timezone_read',
            reason: 'rule_match',
          }),
        ),
      ).toEqual({ pause_requested: true });
      expect(
        (
          await database.pool.query(
            `SELECT 1 FROM run_checkpoints WHERE attempt_id=$1 AND kind='harness_routing_decision'`,
            [f.context.attemptId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await database.pool.query('SELECT 1 FROM tool_invocations WHERE run_id=$1', [
            f.context.runId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(await f.session.handleRequest(request('pause_probe', {}))).toEqual({ pending: true });
      expect(
        await f.session.handleRequest(
          request('pause_point', {
            context: {
              version: 3,
              message_refs: [f.context.userMessageId],
              tool_refs: [],
              next_call_no: 1,
              usage: { iterations: 0, tokens: 0 },
              waiting: null,
              native_state: {
                protected_messages: [],
                units: [],
                hard_denied: '',
                closing_goal: false,
                pending_model: null,
              },
            },
          }),
        ),
      ).toEqual({ paused: true });
      const key = randomUUID();
      const resumed = await continueConversationPause(
        f.deps,
        f.actor.userId,
        f.context.conversationId,
        f.context.runId,
        randomUUID(),
        { pause_id: pause.pause_id },
        key,
      );
      if (!resumed.context) throw new Error('missing resumed context');
      const successor = await createHarnessSession(
        f.deps,
        resumed.context,
        async () => true,
        new AbortController().signal,
      );
      try {
        expect(successor.start.eligible_phase).toBe('disabled');
        expect(successor.start.snapshot?.usage).toEqual({ iterations: 0, tokens: 0 });
        const replay = await continueConversationPause(
          f.deps,
          f.actor.userId,
          f.context.conversationId,
          f.context.runId,
          randomUUID(),
          { pause_id: pause.pause_id },
          key,
        );
        expect(replay.context).toBeNull();
        expect(
          (
            await database.pool.query('SELECT 1 FROM run_attempts WHERE run_id=$1', [
              f.context.runId,
            ])
          ).rowCount,
        ).toBe(2);
      } finally {
        await successor.close();
      }
    } finally {
      await f.session.close();
    }
  }, 30000);

  it('accepted direct decision wins over later pause only for its exact authorized unit', async () => {
    const f = await fixture();
    try {
      const decision = await decide(f);
      const pause = await requestConversationPause(
        f.deps,
        f.actor.userId,
        f.context.conversationId,
        f.context.runId,
        { reason: 'user', purpose: 'none' },
        randomUUID(),
      );
      const toolId = decision.receipt.tool_id!,
        args = decision.receipt.args!;
      const reserved = (await f.session.handleRequest(
        request('reserve', {
          call_key: 'harness/1',
          tool_id: toolId,
          args,
        }),
      )) as { invocation_id: string };
      const outcome = await f.session.handleRequest(
        request('invoke', {
          invocation_id: reserved.invocation_id,
          tool_id: toolId,
          args,
        }),
      );
      await f.session.handleRequest(
        request('snapshot', {
          context: {
            version: 2,
            message_refs: [f.context.userMessageId],
            tool_refs: [reserved.invocation_id],
            next_call_no: 2,
            usage: { iterations: 0, tokens: 0 },
            waiting: null,
          },
        }),
      );
      await render(f, { ...decision, invocation: reserved.invocation_id, outcome });
      await f.session.handleRequest(
        request('finish', { outcome: 'done', usage: { iterations: 0, tokens: 0 } }),
      );
      expect(
        (
          await database.pool.query('SELECT state FROM harness_pauses WHERE id=$1', [
            pause.pause_id,
          ])
        ).rows[0]?.state,
      ).toBe('invalidated');
      expect(
        (
          await database.pool.query('SELECT 1 FROM tool_invocations WHERE run_id=$1', [
            f.context.runId,
          ])
        ).rowCount,
      ).toBe(1);
      expect(f.counts().modelCalls).toBe(0);
      await expect(
        continueConversationPause(
          f.deps,
          f.actor.userId,
          f.context.conversationId,
          f.context.runId,
          randomUUID(),
          { pause_id: pause.pause_id },
          randomUUID(),
        ),
      ).rejects.toThrow();
    } finally {
      await f.session.close();
    }
  }, 30000);

  for (const forged of ['tool', 'args'] as const) {
    it(`rejects a forged ${forged} after direct decision even with a pending pause`, async () => {
      const f = await fixture();
      try {
        const decision = await decide(f);
        await requestConversationPause(
          f.deps,
          f.actor.userId,
          f.context.conversationId,
          f.context.runId,
          { reason: 'user', purpose: 'none' },
          randomUUID(),
        );
        const toolId = decision.receipt.tool_id!,
          args = decision.receipt.args!;
        const reserved = (await f.session.handleRequest(
          request('reserve', {
            call_key: 'harness/1',
            tool_id: toolId,
            args,
          }),
        )) as { invocation_id: string };
        await expect(
          f.session.handleRequest(
            request('invoke', {
              invocation_id: reserved.invocation_id,
              tool_id: forged === 'tool' ? 'list_tasks' : toolId,
              args: forged === 'args' ? { forged: true } : args,
            }),
          ),
        ).rejects.toThrow();
        const rows = await database.pool.query<{ state: string }>(
          'SELECT state FROM tool_invocations WHERE run_id=$1',
          [f.context.runId],
        );
        expect(rows.rows.map((row) => row.state)).toEqual(['reserved']);
        expect(f.counts().modelCalls).toBe(0);
      } finally {
        await f.session.close();
      }
    }, 30000);
  }

  it('records off policy in admission, exposes no internal events and cannot probe', async () => {
    const f = await fixture({ mode: 'off' });
    try {
      expect(f.session.start.routing_policy).toEqual({ revision: 'r2b/1', mode: 'off' });
      expect(f.session.start.eligible_phase).toBe('disabled');
      expect(await listRunEvents(database.pool, f.actor.userId, f.started.runId)).toEqual([]);
      await expect(
        f.frame(request('route_probe', { stage: 'facts', facts_ref: null })),
      ).rejects.toThrow('fresh first step');
      expect(f.counts()).toEqual({
        factsCalls: 0,
        embeddingCalls: 0,
        modelCalls: 0,
        renderCalls: 0,
      });
    } finally {
      await f.session.close();
    }
  });

  it('uses real owner result, immutable receipt, original gateway, snapshot, render, and zero-model terminal', async () => {
    const f = await fixture();
    try {
      await seedSession(database.pool, { timezoneId: 'Europe/Paris' });
      const a = await accepted(f);
      expect(a.outcome).toMatchObject({
        status: 'ok',
        result: { kind: 'prefs', timezone_id: 'Asia/Tokyo' },
      });
      expect(await f.frame(a.decisionRequest)).toEqual(a.receipt);
      expect(await render(f, a)).toEqual({ rendered: true });
      expect(await render(f, a)).toEqual({ rendered: true });
      await f.frame(request('finish', { outcome: 'done', usage: { iterations: 0, tokens: 0 } }));
      const view = await getRunView(
        f.deps,
        f.actor.userId,
        f.context.conversationId,
        f.context.runId,
      );
      expect(view.status).toBe('done');
      expect(f.counts()).toEqual({
        factsCalls: 1,
        embeddingCalls: 0,
        modelCalls: 0,
        renderCalls: 1,
      });
      const stored = await listRunEvents(database.pool, f.actor.userId, f.context.runId);
      const deltas = stored.filter((event) => event.type === 'message.delta');
      expect(deltas.map((event) => event.payload.delta).join('')).toContain('Asia/Tokyo');
      expect(deltas.map((event) => event.payload.delta).join('')).not.toContain('Europe/Paris');
      const kinds = (
        await database.pool.query<{ kind: string }>(
          'SELECT kind FROM run_checkpoints WHERE attempt_id=$1 ORDER BY seq',
          [f.context.attemptId],
        )
      ).rows.map(({ kind }) => kind);
      expect(kinds.filter((kind) => kind.startsWith('harness_routing_'))).toEqual([
        'harness_routing_policy',
        'harness_routing_decision',
        'harness_routing_render',
      ]);
      expect(stored.every((event) => !event.type.startsWith('harness_'))).toBe(true);
      await database.pool.query('UPDATE users SET timezone_id=$2 WHERE id=$1', [
        f.actor.userId,
        'UTC',
      ]);
      const replay = await startConversationRun(f.deps, f.actor.userId, randomUUID(), f.body, null);
      expect(replay.context).toBeNull();
      expect(replay.replay).toEqual(stored);
      expect(
        await listConversationEvents(database.pool, {
          ownerId: f.actor.userId,
          conversationId: f.context.conversationId,
          afterSeq: null,
          limit: 100,
        }),
      ).toEqual(stored);
      expect(f.counts()).toEqual({
        factsCalls: 1,
        embeddingCalls: 0,
        modelCalls: 0,
        renderCalls: 1,
      });
    } finally {
      await f.session.close();
    }
  });

  it('rejects conflicting immutable decision without replacing original UUID', async () => {
    const f = await fixture();
    try {
      const a = await decide(f);
      await expect(f.frame({ ...a.decisionRequest, reason: 'different' })).rejects.toThrow(
        'immutable',
      );
      const rows = (
        await database.pool.query(
          'SELECT id FROM run_checkpoints WHERE attempt_id=$1 AND kind=$2',
          [f.context.attemptId, 'harness_routing_decision'],
        )
      ).rows;
      expect(rows).toEqual([{ id: a.receipt.decision_ref }]);
    } finally {
      await f.session.close();
    }
  });

  for (const forbiddenAction of [
    'second_slot',
    'changed_args',
    'model',
    'native_answer',
    'missing_render',
  ] as const) {
    it(`rejects direct ${forbiddenAction} without success or extra tools`, async () => {
      const f = await fixture();
      try {
        const a = await accepted(f);
        const action =
          forbiddenAction === 'second_slot'
            ? request('reserve', { call_key: 'harness/2', tool_id: 'get_user_prefs', args: {} })
            : forbiddenAction === 'changed_args'
              ? request('invoke', {
                  invocation_id: a.invocation,
                  tool_id: 'get_user_prefs',
                  args: { owner_id: randomUUID() },
                })
              : forbiddenAction === 'model'
                ? request('measure_context', {
                    messages: [{ role: 'user', content: '/timezone' }],
                    remaining_tokens: 8000,
                    max_output_tokens: 512,
                  })
                : forbiddenAction === 'native_answer'
                  ? request('answer', { delta: '伪造正文' })
                  : request('finish', { outcome: 'done', usage: { iterations: 0, tokens: 0 } });
        await expect(f.frame(action)).rejects.toThrow();
        expect(
          (
            await database.pool.query(
              'SELECT invocation_id FROM tool_invocations WHERE run_id=$1',
              [f.context.runId],
            )
          ).rowCount,
        ).toBe(1);
        expect(
          (await getRunView(f.deps, f.actor.userId, f.context.conversationId, f.context.runId))
            .status,
        ).toBe('running');
        expect(f.events).toEqual([]);
      } finally {
        await f.session.close();
      }
    });
  }

  it('counts one encoding outside locks, aborts only after committed cancel, and rejects late evidence', async () => {
    let release!: (value: RoutingEmbedding) => void;
    let entered!: () => void;
    const enteredEncoding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let encodingSignal: AbortSignal | undefined;
    let cached: RoutingFacts | undefined;
    const f = await fixture({
      rule: false,
      text: '读取我的时区',
      embedding: async (_text, facts, _policy, signal) => {
        encodingSignal = signal;
        cached = facts;
        entered();
        return new Promise<RoutingEmbedding>((resolve) => {
          release = resolve;
        });
      },
    });
    try {
      const facts = RoutingFactsSchema.parse(
        await f.frame(request('route_probe', { stage: 'facts', facts_ref: null })),
      );
      const probing = f.frame(
        request('route_probe', { stage: 'embedding', facts_ref: facts.facts_ref }),
      );
      const settled = probing.then(
        () => ({ rejected: false, error: null }),
        (error: unknown) => ({ rejected: true, error }),
      );
      await enteredEncoding;
      const cancelled = await cancelConversationRun(
        f.deps,
        f.actor.userId,
        f.context.conversationId,
        f.context.runId,
        randomUUID(),
        { idempotency_key: randomUUID(), reason: 'test_cancel' },
      );
      expect(cancelled.status).toBe('cancelled');
      expect(encodingSignal?.aborted).toBe(true);
      release({
        facts_ref: cached!.facts_ref,
        input_sha256: cached!.input_sha256,
        bundle_sha256: cached!.bundle_sha256,
        reason: null,
        scores: [],
      });
      expect(await settled).toMatchObject({ rejected: true, error: expect.any(Error) });
      expect(f.counts().embeddingCalls).toBe(1);
      expect(f.events).toEqual([]);
      expect(
        (
          await database.pool.query('SELECT invocation_id FROM tool_invocations WHERE run_id=$1', [
            f.context.runId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await database.pool.query(
            `SELECT id FROM run_checkpoints WHERE attempt_id=$1 AND kind IN ('harness_routing_decision','harness_routing_render')`,
            [f.context.attemptId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await f.session.close();
    }
  });

  it('accepts encoding evidence once and never re-encodes or accepts foreign facts reference', async () => {
    const f = await fixture({ rule: false });
    try {
      const facts = RoutingFactsSchema.parse(
        await f.frame(request('route_probe', { stage: 'facts', facts_ref: null })),
      );
      await f.frame(request('route_probe', { stage: 'embedding', facts_ref: facts.facts_ref }));
      await expect(
        f.frame(request('route_probe', { stage: 'embedding', facts_ref: facts.facts_ref })),
      ).rejects.toThrow('out of order');
      expect(f.counts().embeddingCalls).toBe(1);
    } finally {
      await f.session.close();
    }
    const foreign = await fixture();
    try {
      await foreign.frame(request('route_probe', { stage: 'facts', facts_ref: null }));
      await expect(
        foreign.frame(
          request('route_decide', {
            decision: 'direct',
            facts_ref: randomUUID(),
            candidate_intent: 'prefs_timezone_read',
            reason: 'foreign',
          }),
        ),
      ).rejects.toThrow('cached');
    } finally {
      await foreign.session.close();
    }
  });

  it('shadow terminal fallback retains original model input and unknown provider usage', async () => {
    const f = await fixture({ mode: 'shadow', text: '完整原话不得注入猜测标签' });
    try {
      const facts = RoutingFactsSchema.parse(
        await f.frame(request('route_probe', { stage: 'facts', facts_ref: null })),
      );
      await f.frame(
        request('route_decide', {
          decision: 'fallback',
          facts_ref: facts.facts_ref,
          candidate_intent: null,
          reason: 'shadow',
        }),
      );
      const model = request('model', {
        messages: f.session.start.messages.map(({ role, content }) => ({ role, content })),
        remaining_tokens: 8000,
        max_output_tokens: 512,
      });
      expect(await f.frame(model)).toEqual({ type: 'delta', delta: '原模型回答' });
      await f.frame(request('answer', { delta: '原模型回答' }));
      await f.frame(request('model_next', { model_ref: model.request_ref }));
      await f.frame(request('finish', { outcome: 'done', usage: { iterations: 1, tokens: null } }));
      expect(f.counts()).toEqual({
        factsCalls: 1,
        embeddingCalls: 0,
        modelCalls: 1,
        renderCalls: 0,
      });
      expect(f.modelInputs[0]?.messages).toEqual(
        f.session.start.messages.map(({ role, content }) => ({ role, content })),
      );
      expect(
        (
          await database.pool.query('SELECT invocation_id FROM tool_invocations WHERE run_id=$1', [
            f.context.runId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (await listRunEvents(database.pool, f.actor.userId, f.context.runId)).filter(
          (event) => event.type === 'message.delta',
        ),
      ).toHaveLength(1);
    } finally {
      await f.session.close();
    }
  });

  it('shadow cannot authorize direct or use protocol failure as semantic fallback', async () => {
    const f = await fixture({ mode: 'shadow' });
    try {
      const facts = RoutingFactsSchema.parse(
        await f.frame(request('route_probe', { stage: 'facts', facts_ref: null })),
      );
      await expect(
        f.frame(
          request('route_decide', {
            decision: 'direct',
            facts_ref: facts.facts_ref,
            candidate_intent: 'prefs_timezone_read',
            reason: 'illegal',
          }),
        ),
      ).rejects.toThrow('not authorized');
      await expect(
        f.frame(
          request('route_decide', {
            decision: 'fallback',
            facts_ref: facts.facts_ref,
            candidate_intent: null,
            reason: 'hide_error',
          }),
        ),
      ).rejects.toThrow('stopped');
      expect(f.counts().modelCalls).toBe(0);
    } finally {
      await f.session.close();
    }
  });

  it('rejects foreign owner and Unicode UTF-16 source rather than silently falling back', async () => {
    for (const corrupt of ['owner', 'utf16'] as const) {
      const f = await fixture({
        text: '😀提醒5条',
        facts: (facts) => ({
          ...facts,
          rule_intent: 'task_list_bounded',
          candidates: [
            {
              intent: 'task_list_bounded',
              tool_id: 'list_tasks',
              args: { limit: 5 },
              sources: [
                {
                  field: 'limit',
                  source: 'message',
                  message_id: corrupt === 'owner' ? randomUUID() : '',
                  raw: '5',
                  start: corrupt === 'utf16' ? 4 : 3,
                  end: corrupt === 'utf16' ? 5 : 4,
                  parser_revision: 'test-parser/1',
                },
              ],
            },
          ],
        }),
      });
      // Capture real message reference after admission, but deliberately retain bad scalar offsets.
      const factsImpl = f.deps.routing!.facts;
      f.deps.routing!.facts = (...args) => {
        const facts = factsImpl(...args);
        const source = facts.candidates[0]!.sources[0]!;
        if (source.source === 'message' && corrupt === 'utf16')
          source.message_id = args[0].messageId;
        return facts;
      };
      try {
        await expect(
          f.frame(request('route_probe', { stage: 'facts', facts_ref: null })),
        ).rejects.toThrow();
        await expect(
          f.frame(
            request('route_decide', {
              decision: 'fallback',
              facts_ref: randomUUID(),
              candidate_intent: null,
              reason: 'hide_source_error',
            }),
          ),
        ).rejects.toThrow('stopped');
        expect(
          (
            await database.pool.query(
              'SELECT invocation_id FROM tool_invocations WHERE run_id=$1',
              [f.context.runId],
            )
          ).rowCount,
        ).toBe(0);
      } finally {
        await f.session.close();
      }
    }
  });

  it('keeps policy and original admission atomic under a real insert fault', async () => {
    const f = await fixture({ mode: 'off' });
    try {
      await database.pool
        .query(`CREATE FUNCTION reject_test_routing_policy() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.kind='harness_routing_policy' THEN RAISE EXCEPTION 'injected policy failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_test_routing_policy BEFORE INSERT ON run_checkpoints FOR EACH ROW EXECUTE FUNCTION reject_test_routing_policy()`);
      const counts = await database.pool.query(
        `SELECT (SELECT count(*) FROM agent_runs)::int AS runs,(SELECT count(*) FROM run_attempts)::int AS attempts,(SELECT count(*) FROM messages)::int AS messages`,
      );
      try {
        await expect(
          startConversationRun(
            f.deps,
            f.actor.userId,
            randomUUID(),
            {
              conversation_id: await createFixtureConversation(database.pool, f.actor.userId),
              execution: 'harness',
              raw_text: '/timezone',
              idempotency_key: randomUUID(),
            },
            null,
          ),
        ).rejects.toThrow('injected policy failure');
        expect(
          (
            await database.pool.query(
              `SELECT (SELECT count(*) FROM agent_runs)::int AS runs,(SELECT count(*) FROM run_attempts)::int AS attempts,(SELECT count(*) FROM messages)::int AS messages`,
            )
          ).rows,
        ).toEqual(counts.rows);
      } finally {
        await database.pool.query(
          'DROP TRIGGER reject_test_routing_policy ON run_checkpoints; DROP FUNCTION reject_test_routing_policy()',
        );
      }
    } finally {
      await f.session.close();
    }
  });

  it('rolls back all display deltas when render receipt persistence fails', async () => {
    const f = await fixture({ render: () => '真实完整投影😀'.repeat(800) });
    try {
      const a = await accepted(f);
      await database.pool
        .query(`CREATE FUNCTION reject_test_routing_render() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.kind='harness_routing_render' THEN RAISE EXCEPTION 'injected render failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_test_routing_render BEFORE INSERT ON run_checkpoints FOR EACH ROW EXECUTE FUNCTION reject_test_routing_render()`);
      try {
        await expect(render(f, a)).rejects.toThrow('injected render failure');
        expect(await listRunEvents(database.pool, f.actor.userId, f.context.runId)).toEqual([]);
        expect(f.events).toEqual([]);
      } finally {
        await database.pool.query(
          'DROP TRIGGER reject_test_routing_render ON run_checkpoints; DROP FUNCTION reject_test_routing_render()',
        );
      }
    } finally {
      await f.session.close();
    }
  });

  it('cancellation after accepted result rejects rendering and cannot disclose late output', async () => {
    const f = await fixture();
    try {
      const a = await accepted(f);
      await cancelConversationRun(
        f.deps,
        f.actor.userId,
        f.context.conversationId,
        f.context.runId,
        randomUUID(),
        { idempotency_key: randomUUID(), reason: 'before_render' },
      );
      await expect(render(f, a)).rejects.toThrow();
      expect(f.events).toEqual([]);
      expect(f.counts().renderCalls).toBe(0);
    } finally {
      await f.session.close();
    }
  });

  it('keeps unbound legacy Run reads available but rejects sessions without backfilling routing policy', async () => {
    const f = await fixture();
    const runId = randomUUID(),
      attemptId = randomUUID();
    try {
      await database.pool.query(
        `WITH legacy AS (
        INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,
          budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
        SELECT $2,owner_id,conversation_id,agent_revision,mode,'running',
          budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id
          FROM agent_runs WHERE id=$1 RETURNING id,owner_id
        ) INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status)
          SELECT $3,owner_id,id,1,'running' FROM legacy`,
        [f.context.runId, runId, attemptId],
      );
      await database.pool.query(
        `INSERT INTO run_context_policies(run_id,owner_id,policy,policy_hash)
        SELECT $2,owner_id,policy,policy_hash FROM run_context_policies WHERE run_id=$1`,
        [f.context.runId, runId],
      );
      const legacy = { ...f.context, runId, attemptId };
      await getRunView(f.deps, f.actor.userId, f.context.conversationId, runId);
      await expect(
        createHarnessSession(f.deps, legacy, async () => true, new AbortController().signal),
      ).rejects.toMatchObject({
        errorCode: 'STATE_CONFLICT',
        message: 'legacy Run model binding unavailable; cannot resume',
      });
      expect(
        await withTransaction(database.pool, (client) =>
          readRoutingPolicy(client, f.actor.userId, runId),
        ),
      ).toBeNull();
      expect(f.counts().factsCalls).toBe(0);
      expect(
        (await database.pool.query('SELECT id FROM run_attempts WHERE run_id=$1', [runId]))
          .rowCount,
      ).toBe(1);
    } finally {
      await f.session.close();
    }
  });

  for (const intent of ['task_list_bounded', 'brief_cards_read'] as const) {
    it(`binds ${intent} sources through original gateway result and renderer`, async () => {
      const f = await fixture({
        text: intent === 'task_list_bounded' ? '/reminders' : '/brief 2026-10-31',
        facts: (facts) => ({
          ...facts,
          rule_intent: intent,
          candidates:
            intent === 'task_list_bounded'
              ? [
                  {
                    intent,
                    tool_id: 'list_tasks',
                    args: { limit: 20, state: null },
                    sources: [
                      {
                        field: 'limit',
                        source: 'contract_default',
                        parser_revision: 'test-parser/1',
                      },
                      {
                        field: 'state',
                        source: 'contract_default',
                        parser_revision: 'test-parser/1',
                      },
                    ],
                  },
                ]
              : [
                  {
                    intent,
                    tool_id: 'read_brief_cards',
                    args: { date: '2026-10-31' },
                    sources: [],
                  },
                ],
        }),
      });
      if (intent === 'brief_cards_read') {
        await database.pool.query('UPDATE users SET timezone_id=NULL WHERE id=$1', [
          f.actor.userId,
        ]);
        const original = f.deps.routing!.facts;
        f.deps.routing!.facts = (...args) => {
          const facts = original(...args);
          facts.candidates[0]!.sources = [
            {
              field: 'date',
              source: 'message',
              message_id: args[0].messageId,
              raw: '2026-10-31',
              start: 7,
              end: 17,
              parser_revision: 'test-parser/1',
            },
          ];
          return facts;
        };
      }
      try {
        const a = await accepted(f);
        expect(a.outcome).toMatchObject({
          status: 'ok',
          result: { kind: intent === 'task_list_bounded' ? 'list_tasks' : 'brief' },
        });
        await render(f, a);
        await f.frame(request('finish', { outcome: 'done', usage: { iterations: 0, tokens: 0 } }));
        expect(f.counts().modelCalls).toBe(0);
        expect(f.counts().embeddingCalls).toBe(0);
        expect(f.events.some((event) => event.type === 'message.delta')).toBe(true);
      } finally {
        await f.session.close();
      }
    });
  }

  it('SQL validates actual cross-owner message source even when writer bypasses authority helper validation', async () => {
    const f = await fixture({ text: '5' });
    const other = await fixture({ text: '5' });
    try {
      const facts: RoutingFacts = {
        facts_ref: randomUUID(),
        input_sha256: routingHash('5'),
        bundle_sha256: 'a'.repeat(64),
        eligible: true,
        reason: null,
        rule_intent: null,
        candidates: [
          {
            intent: 'task_list_bounded',
            tool_id: 'list_tasks',
            args: { limit: 5 },
            sources: [
              {
                field: 'limit',
                source: 'message',
                message_id: other.context.userMessageId,
                raw: '5',
                start: 0,
                end: 1,
                parser_revision: 'test-parser/1',
              },
            ],
          },
        ],
      };
      await expect(
        withTransaction(database.pool, async (client) => {
          await lockRun(client, f.context);
          const policy = await readRoutingPolicy(client, f.actor.userId, f.context.runId);
          await acceptRoutingDecision(
            client,
            f.context,
            decisionPayload(
              f.context,
              policy!.id,
              facts,
              null,
              0,
              'fallback',
              'source-check',
              null,
            ),
          );
        }),
      ).rejects.toThrow('message source');
      const source = facts.candidates[0]!.sources[0]!;
      if (source.source !== 'message') throw new Error('message source expected');
      source.message_id = f.context.userMessageId;
      await withTransaction(database.pool, async (client) => {
        await lockRun(client, f.context);
        const policy = await readRoutingPolicy(client, f.actor.userId, f.context.runId);
        await acceptRoutingDecision(
          client,
          f.context,
          decisionPayload(f.context, policy!.id, facts, null, 0, 'fallback', 'source-check', null),
        );
      });
      expect(await listRunEvents(database.pool, f.actor.userId, f.context.runId)).toEqual([]);
    } finally {
      await f.session.close();
      await other.session.close();
    }
  });

  it('SQL rejects mutation, duplicate kind, forged owner/source and late policy backfill', async () => {
    const f = await fixture();
    const other = await fixture();
    try {
      const a = await decide(f);
      await expect(
        database.pool.query(`UPDATE run_checkpoints SET payload=payload WHERE id=$1`, [
          a.receipt.decision_ref,
        ]),
      ).rejects.toThrow('append-only');
      await expect(
        database.pool.query(`DELETE FROM run_checkpoints WHERE id=$1`, [a.receipt.decision_ref]),
      ).rejects.toThrow('append-only');
      await expect(
        database.pool.query(
          `INSERT INTO run_checkpoints(id,owner_id,attempt_id,seq,kind,payload,stream_protocol_version)
        SELECT $2,owner_id,attempt_id,seq+20,kind,payload,stream_protocol_version FROM run_checkpoints WHERE id=$1`,
          [a.receipt.decision_ref, randomUUID()],
        ),
      ).rejects.toThrow();
      await expect(
        database.pool.query(
          `INSERT INTO run_checkpoints(id,owner_id,attempt_id,seq,kind,payload,stream_protocol_version)
        SELECT $2,$3,attempt_id,seq+20,kind,payload,stream_protocol_version FROM run_checkpoints WHERE id=$1`,
          [a.receipt.decision_ref, randomUUID(), other.actor.userId],
        ),
      ).rejects.toThrow('source owner');
      await expect(
        withTransaction(database.pool, async (client) => {
          await lockRun(client, other.context);
          await insertRoutingPolicy(client, other.context, enabled);
        }),
      ).rejects.toThrow('original admission');
      await expect(
        withTransaction(database.pool, async (client) => {
          const attemptId = randomUUID();
          await client.query(
            `INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status)
          VALUES($1,$2,$3,2,'running')`,
            [attemptId, f.actor.userId, f.context.runId],
          );
          await insertRoutingPolicy(client, { ...f.context, attemptId }, enabled);
        }),
      ).rejects.toThrow('first attempt');
      expect(
        await withTransaction(database.pool, (client) =>
          readRoutingPolicy(client, f.actor.userId, f.context.runId),
        ),
      ).not.toBeNull();
    } finally {
      await f.session.close();
      await other.session.close();
    }
  });
});
