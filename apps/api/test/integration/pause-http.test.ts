import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { HARNESS_PROTOCOL_VERSION, HARNESS_R3_PROTOCOL_VERSION } from '@along/contracts';
import { handleRequest } from '../../src/http/app.js';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { createHarnessModelTransport } from '../../src/modules/conversations/harness-model.js';
import {
  createHarnessSession,
  resumeConversationRun,
} from '../../src/modules/conversations/harness-authority.js';
import { createRunDriver } from '../../src/modules/conversations/run-driver.js';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import {
  executeNonTransactionalInvocation,
  reserveInvocation,
} from '../../src/modules/tools/invocations.js';
import { rejectApproval } from '../../src/modules/approvals/confirm.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import { listen, sendModelSse } from '../helpers/harness-consumer.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const binaryPath = process.env.HARNESS_BINARY;
const maybe = databaseUrl && binaryPath ? describe : describe.skip;

maybe('user pause and continue over HTTP', () => {
  let database: IntegrationDatabase;

  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });

  async function fixture(maxIterations = 8) {
    const session = await seedAdmittedSession(database.pool);
    const foreign = await seedAdmittedSession(database.pool);
    await configureTestModel(database.pool, session.userId, 'fixture-transport-only');
    const release = Promise.withResolvers<void>();
    let calls = 0;
    let modelEntered = false;
    const modelServer = createServer((_req, res) => {
      calls += 1;
      const call = calls;
      void (async () => {
        if (call === 2) {
          modelEntered = true;
          await release.promise;
        }
        if (res.destroyed) return;
        sendModelSse(res, {
          message: {
            content: null,
            tool_calls: [
              {
                id: `fixture-${call}`,
                type: 'function',
                function:
                  call === 1
                    ? { name: 'get_user_prefs', arguments: '{}' }
                    : {
                        name: 'finish_goal',
                        arguments: JSON.stringify({
                          status: 'completed',
                          outcomes: [{ description: '回答', status: 'achieved', receipt_refs: [] }],
                          clarification: null,
                          answer: '完成',
                        }),
                      },
              },
            ],
          },
          usage: { total_tokens: 5 },
        });
      })();
    });
    const modelBase = await listen(modelServer);
    const transport = createHarnessModelTransport({
      baseUrl: `${modelBase}/v1`,
      model: 'fixture-transport-only',
    });
    let exposedTools: string[] = [];
    const driver = createRunDriver(database.pool);
    const deps = {
      pool: database.pool,
      timeContext: loadTimeContext('fixture-v1'),
      runDriver: driver,
      harness: {
        binaryPath: binaryPath!,
        libraryPath: process.env.HARNESS_LIBRARY_PATH,
        maxIterations,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({
          completionCap: 1024,
          model: 'fixture-transport-only',
        }),
        model: async function* (...args: Parameters<typeof transport>) {
          exposedTools = args[1].map((tool) => tool.name);
          yield* transport(...args);
        },
      },
    };
    controlledModelDeps(deps);
    const api = createServer((req, res) => {
      void handleRequest(req, res, deps).catch(() => res.destroy());
    });
    const base = await listen(api);
    const headers = {
      cookie: `better-auth.session_token=${session.token}`,
      'x-csrf-token': session.csrfToken,
    };
    const foreignHeaders = {
      cookie: `better-auth.session_token=${foreign.token}`,
      'x-csrf-token': foreign.csrfToken,
    };
    const run = await startConversationRun(
      deps,
      session.userId,
      randomUUID(),
      {
        execution: 'harness',
        authorization_revision: 'delegation/1',
        raw_text: '请读取偏好并回答。',
      },
      randomUUID(),
    );
    const deadline = Date.now() + 10000;
    let runStatus = 'running';
    while (!modelEntered && runStatus === 'running' && Date.now() < deadline) {
      runStatus = (
        await database.pool.query<{ status: string }>('SELECT status FROM agent_runs WHERE id=$1', [
          run.runId,
        ])
      ).rows[0]!.status;
      if (!modelEntered && runStatus === 'running') await delay(20);
    }
    if (!modelEntered) {
      const events = (
        await database.pool.query(
          `SELECT c.kind,c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
         WHERE a.run_id=$1 ORDER BY c.event_seq`,
          [run.runId],
        )
      ).rows;
      release.resolve();
      await driver.shutdown();
      for (const server of [api, modelServer]) {
        const closed = once(server, 'close');
        server.closeAllConnections();
        server.close();
        await closed;
      }
      throw new Error(`model barrier not reached: ${JSON.stringify({ runStatus, calls, events })}`);
    }
    const path = `${base}/api/v1/conversations/${run.conversationId}/runs/${run.runId}`;
    const post = (action: string, body: unknown, key: string, auth = headers) =>
      fetch(`${path}/actions/${action}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      });
    const get = () => fetch(path, { headers });
    const invocations = async () =>
      (
        await database.pool.query(
          'SELECT invocation_id,tool_id,state FROM tool_invocations WHERE run_id=$1 ORDER BY created_at,invocation_id',
          [run.runId],
        )
      ).rows;
    const attempts = async () =>
      (
        await database.pool.query('SELECT count(*)::int AS n FROM run_attempts WHERE run_id=$1', [
          run.runId,
        ])
      ).rows[0]!.n as number;
    const close = async () => {
      release.resolve();
      await driver.shutdown();
      for (const server of [api, modelServer]) {
        const closed = once(server, 'close');
        server.closeAllConnections();
        server.close();
        await closed;
      }
    };
    return {
      run,
      path,
      headers,
      foreignHeaders,
      post,
      get,
      invocations,
      attempts,
      release,
      close,
      calls: () => calls,
      exposedTools: () => exposedTools,
    };
  }

  async function paused(f: { get: () => Promise<Response> }, pauseId: string) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const response = await f.get();
      expect(response.status).toBe(200);
      const { data } = (await response.json()) as {
        data: { status: string; pause: { pause_id: string } | null };
      };
      if (data.status === 'paused') {
        expect(data.pause?.pause_id).toBe(pauseId);
        return;
      }
      await delay(50);
    }
    throw new Error('run did not reach a paused safe point');
  }

  it('drains the active model, stays paused across reads, and permits only one explicit continuation', async () => {
    const f = await fixture();
    try {
      const frozen = (
        await database.pool.query<{ tools_allowlist: string[]; profile: string }>(
          `SELECT tools_allowlist,frozen_context->>'execution_profile' AS profile FROM agent_runs WHERE id=$1`,
          [f.run.runId],
        )
      ).rows[0]!;
      expect(frozen.profile).toBe('pause/1');
      expect(frozen.tools_allowlist).not.toContain('read_memory_source');
      expect(f.exposedTools()).not.toContain('read_memory_source');
      const pauseKey = randomUUID();
      const body = { reason: 'user', purpose: 'none' };
      const denied = await f.post('pause', body, randomUUID(), f.foreignHeaders);
      expect(denied.status).toBe(404);
      const noCsrf = await f.post('pause', body, randomUUID(), {
        cookie: f.headers.cookie,
        'x-csrf-token': '',
      });
      expect(noCsrf.status).toBe(403);
      const requested = await f.post('pause', body, pauseKey);
      expect(requested.status).toBe(200);
      const first = ((await requested.json()) as { data: { status: string; pause_id: string } })
        .data;
      expect(first.status).toBe('pending');
      expect(first.pause_id).toMatch(/^[0-9a-f-]{36}$/i);
      const replay = await f.post('pause', body, pauseKey);
      expect(replay.status).toBe(200);
      expect(((await replay.json()) as { data: { pause_id: string } }).data.pause_id).toBe(
        first.pause_id,
      );
      expect(f.calls()).toBe(2);
      const before = await f.invocations();
      expect(
        before.filter((row) => row.tool_id === 'get_user_prefs' && row.state === 'completed'),
      ).toHaveLength(1);
      f.release.resolve();
      await paused(f, first.pause_id);
      for (let i = 0; i < 3; i++) {
        expect((await f.get()).status).toBe(200);
        await delay(100);
      }
      expect(f.calls()).toBe(2);
      expect(await f.invocations()).toEqual(before);
      expect(await f.attempts()).toBe(1);
      expect((await f.post('continue', { pause_id: randomUUID() }, randomUUID())).status).toBe(409);
      expect(
        (await f.post('continue', { pause_id: first.pause_id }, randomUUID(), f.foreignHeaders))
          .status,
      ).toBe(404);
      expect(
        (
          await f.post(
            'resume',
            { checkpoint_id: first.pause_id, idempotency_key: randomUUID() },
            randomUUID(),
          )
        ).status,
      ).toBe(409);
      const keyA = randomUUID();
      const keyB = randomUUID();
      const [a, b] = await Promise.all([
        f.post('continue', { pause_id: first.pause_id }, keyA),
        f.post('continue', { pause_id: first.pause_id }, keyB),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const winner = a.status === 200 ? a : b;
      expect(winner.headers.get('content-type')).toContain('text/event-stream');
      await winner.text();
      const replayContinue = await f.post(
        'continue',
        { pause_id: first.pause_id },
        a.status === 200 ? keyA : keyB,
      );
      expect(replayContinue.status).toBe(200);
      await replayContinue.text();
      expect(await f.attempts()).toBe(2);
      const after = await f.invocations();
      expect(after.filter((row) => row.tool_id === 'get_user_prefs')).toEqual(
        before.filter((row) => row.tool_id === 'get_user_prefs'),
      );
      expect((await f.post('continue', { pause_id: first.pause_id }, randomUUID())).status).toBe(
        409,
      );
    } finally {
      await f.close();
    }
  }, 45000);

  it('continues an already generated final goal at the iteration limit', async () => {
    const f = await fixture(2);
    try {
      const response = await f.post('pause', { reason: 'user', purpose: 'none' }, randomUUID());
      expect(response.status).toBe(200);
      const { pause_id } = (await response.json()).data;
      f.release.resolve();
      await paused(f, pause_id);
      const continued = await f.post('continue', { pause_id }, randomUUID());
      expect(continued.status).toBe(200);
      await continued.text();
      const view = await (await f.get()).json();
      expect(view.data.status).toBe('done');
      expect(f.calls()).toBe(2);
    } finally {
      await f.close();
    }
  }, 45000);

  it('cancellation of a paused run invalidates its pause and prevents a successor', async () => {
    const f = await fixture();
    try {
      const response = await f.post('pause', { reason: 'user', purpose: 'none' }, randomUUID());
      expect(response.status).toBe(200);
      const { pause_id } = ((await response.json()) as { data: { pause_id: string } }).data;
      f.release.resolve();
      await paused(f, pause_id);
      const before = await f.invocations();
      const cancelled = await f.post(
        'cancel',
        { idempotency_key: randomUUID(), reason: 'user_cancelled' },
        randomUUID(),
      );
      expect(cancelled.status).toBe(200);
      expect(((await cancelled.json()) as { data: { status: string } }).data.status).toBe(
        'cancelled',
      );
      expect((await f.post('continue', { pause_id }, randomUUID())).status).toBe(409);
      expect(await f.attempts()).toBe(1);
      expect(await f.invocations()).toEqual(before);
      expect(f.calls()).toBe(2);
    } finally {
      await f.close();
    }
  }, 45000);

  it('cancellation wins while a pause is waiting for an in-flight model', async () => {
    const f = await fixture();
    try {
      const requested = await f.post('pause', { reason: 'user', purpose: 'none' }, randomUUID());
      expect(requested.status).toBe(200);
      const { pause_id } = ((await requested.json()) as { data: { pause_id: string } }).data;
      const before = await f.invocations();
      const cancelled = await f.post(
        'cancel',
        { idempotency_key: randomUUID(), reason: 'user_cancelled' },
        randomUUID(),
      );
      expect(cancelled.status).toBe(200);
      expect(((await cancelled.json()) as { data: { status: string } }).data.status).toBe(
        'cancelled',
      );
      f.release.resolve();
      expect((await f.post('continue', { pause_id }, randomUUID())).status).toBe(409);
      expect(await f.attempts()).toBe(1);
      expect(await f.invocations()).toEqual(before);
      expect(f.calls()).toBe(2);
    } finally {
      await f.close();
    }
  }, 45000);
});

// These cases drive the authority session directly, so they also run without a
// native binary and exercise persisted legacy and uncertain-effect facts.
(databaseUrl ? describe : describe.skip)('pause compatibility and uncertain effects', () => {
  let database: IntegrationDatabase;
  let api: Server;
  let base: string;
  const deps = () =>
    controlledModelDeps({
      pool: database.pool,
      timeContext: loadTimeContext('fixture-v1'),
      harness: {
        binaryPath: process.env.HARNESS_BINARY ?? '/app/harness/bin/along-harness',
        maxIterations: 8,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({ completionCap: 512, model: 'pause-authority-model' }),
        model: async function* () {
          yield {
            type: 'complete' as const,
            reply: { message: { content: 'answer', tool_calls: [] }, usage: null },
          };
        },
      },
    });
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    api = createServer((req, res) => {
      void handleRequest(req, res, deps()).catch(() => res.destroy());
    });
    base = await listen(api);
  });
  afterAll(async () => {
    if (api) {
      const closed = once(api, 'close');
      api.closeAllConnections();
      api.close();
      await closed;
    }
    await database?.close();
  });
  async function fresh(legacy = false) {
    const actor = await seedAdmittedSession(database.pool);
    await configureTestModel(database.pool, actor.userId, 'pause-authority-model');
    const started = await startConversationRun(
      deps(),
      actor.userId,
      randomUUID(),
      {
        execution: 'harness',
        raw_text: '2027-11-02 09:20 提醒我喝水',
        confirmed_timezone: 'Asia/Shanghai',
      },
      randomUUID(),
    );
    if (!started.context?.userMessageId) throw new Error('missing fixture user context');
    let runId = started.runId;
    let context = { ...started.context, userMessageId: started.context.userMessageId };
    if (legacy) {
      runId = randomUUID();
      const attemptId = randomUUID();
      // Insert historical authority as accepted, rather than mutating an immutable Run.
      await database.pool.query(
        `WITH legacy AS (
          INSERT INTO agent_runs (id,owner_id,conversation_id,agent_revision,mode,status,
            budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
          SELECT $2,owner_id,conversation_id,agent_revision,mode,'running',
            budget_max_iterations,budget_max_tokens,execution,tools_allowlist,
            frozen_context - 'execution_profile',input_message_id
          FROM agent_runs WHERE id=$1 RETURNING id,owner_id
        ) INSERT INTO run_attempts (id,owner_id,run_id,attempt_no,status)
          SELECT $3,owner_id,id,1,'running' FROM legacy`,
        [started.runId, runId, attemptId],
      );
      await database.pool.query(
        `INSERT INTO run_context_policies(run_id,owner_id,policy,policy_hash)
         SELECT $2,owner_id,policy,policy_hash FROM run_context_policies WHERE run_id=$1`,
        [started.runId, runId],
      );
      await database.pool.query(
        `INSERT INTO model_provider_run_bindings(run_id,owner_id,version_id,provider_id,provider_name,model_id)
         SELECT $2,owner_id,version_id,provider_id,provider_name,model_id
         FROM model_provider_run_bindings WHERE run_id=$1`,
        [started.runId, runId],
      );
      const historicalContext = { ...context };
      delete historicalContext.executionProfile;
      context = {
        ...historicalContext,
        runId,
        attemptId,
      };
    }
    const path = `${base}/api/v1/conversations/${started.conversationId}/runs/${runId}`;
    const post = (action: string, body: unknown, key = randomUUID()) =>
      fetch(`${path}/actions/${action}`, {
        method: 'POST',
        headers: {
          cookie: `better-auth.session_token=${actor.token}`,
          'x-csrf-token': actor.csrfToken,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(body),
      });
    return { actor, started: { ...started, runId }, context, post };
  }

  for (const action of ['model', 'reserve'] as const) {
    it(`linearizes pause registration before a previously probed ${action}`, async () => {
      const f = await fresh();
      const session = await createHarnessSession(
        deps(),
        f.context,
        async () => true,
        new AbortController().signal,
      );
      const protocol = session.start.protocol;
      const locker = await database.pool.connect();
      try {
        expect(protocol).toBe(HARNESS_R3_PROTOCOL_VERSION);
        expect(session.start.tools.map((tool) => tool.name)).not.toContain('read_memory_source');
        expect(
          await session.handleRequest({
            protocol,
            request_ref: randomUUID(),
            type: 'pause_probe',
          }),
        ).toEqual({ pending: false });
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM run_attempts WHERE id=$1 FOR UPDATE', [
          f.context.attemptId,
        ]);
        await locker.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE', [f.context.runId]);
        const pauseId = randomUUID();
        await locker.query(
          `INSERT INTO harness_pauses(id,owner_id,conversation_id,run_id,attempt_id,idempotency_key,reason,purpose,resume_source,state)
           VALUES($1,$2,$3,$4,$5,$6,'user','none','user','pending')`,
          [
            pauseId,
            f.actor.userId,
            f.started.conversationId,
            f.started.runId,
            f.context.attemptId,
            randomUUID(),
          ],
        );
        const request =
          action === 'model'
            ? {
                protocol,
                request_ref: randomUUID(),
                type: 'model' as const,
                messages: [{ role: 'user' as const, content: f.context.inputText }],
                remaining_tokens: f.context.maxTokens,
                max_output_tokens: 128,
              }
            : {
                protocol,
                request_ref: randomUUID(),
                type: 'reserve' as const,
                call_key: 'harness/1',
                tool_id: 'list_tasks',
                args: {},
              };
        const pending = session.handleRequest(request);
        await delay(30);
        await locker.query('COMMIT');
        expect(await pending).toEqual(
          action === 'model' ? { type: 'pause_requested' } : { pause_requested: true },
        );
        expect(
          (
            await database.pool.query(
              'SELECT count(*)::int AS n FROM tool_invocations WHERE run_id=$1',
              [f.started.runId],
            )
          ).rows[0]?.n,
        ).toBe(0);
        expect(
          await session.handleRequest({
            protocol,
            request_ref: randomUUID(),
            type: 'pause_probe',
          }),
        ).toEqual({ pending: true });
        expect(
          await session.handleRequest({
            protocol,
            request_ref: randomUUID(),
            type: 'pause_point',
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
        ).toEqual({ paused: true });
        expect(
          (
            await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [
              f.started.runId,
            ])
          ).rows[0]?.status,
        ).toBe('paused');
      } finally {
        await locker.query('ROLLBACK');
        locker.release();
        await session.close();
      }
    }, 30000);
  }

  it('invalidates an outstanding pause when an accepted tool enters approval waiting', async () => {
    const f = await fresh();
    const session = await createHarnessSession(
      deps(),
      f.context,
      async () => true,
      new AbortController().signal,
    );
    try {
      const protocol = HARNESS_R3_PROTOCOL_VERSION;
      const args = {
        raw_time_text: f.context.inputText,
        timezone_hint: 'Asia/Shanghai',
        note: '喝水',
        occurrence: 'once' as const,
      };
      expect(
        await session.handleRequest({
          protocol,
          request_ref: randomUUID(),
          type: 'pause_probe',
        }),
      ).toEqual({ pending: false });
      const reserve = (await session.handleRequest({
        protocol,
        request_ref: randomUUID(),
        type: 'reserve',
        call_key: 'harness/1',
        tool_id: 'propose_task',
        args,
      })) as { invocation_id: string };
      const pause = await f.post('pause', { reason: 'user', purpose: 'none' });
      expect(pause.status).toBe(200);
      const { pause_id } = (await pause.json()).data;
      const outcome = (await session.handleRequest({
        protocol,
        request_ref: randomUUID(),
        type: 'invoke',
        invocation_id: reserve.invocation_id,
        tool_id: 'propose_task',
        args,
      })) as { result: { approval: { approvalId: string } } };
      const approvalId = outcome.result.approval.approvalId;
      const checkpoint = (await session.handleRequest({
        protocol,
        request_ref: randomUUID(),
        type: 'snapshot',
        context: {
          version: 2,
          message_refs: [f.context.userMessageId],
          tool_refs: [reserve.invocation_id],
          next_call_no: 2,
          usage: { iterations: 1, tokens: null },
          waiting: { invocation_id: reserve.invocation_id, approval_id: approvalId },
        },
      })) as { checkpoint_ref: string };
      await session.handleRequest({
        protocol,
        request_ref: randomUUID(),
        type: 'suspend',
        checkpoint_ref: checkpoint.checkpoint_ref,
        invocation_id: reserve.invocation_id,
        approval_id: approvalId,
      });
      expect(
        (await database.pool.query('SELECT state FROM harness_pauses WHERE id=$1', [pause_id]))
          .rows[0]?.state,
      ).toBe('invalidated');
      expect(
        (await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [f.started.runId]))
          .rows[0]?.status,
      ).toBe('suspended_approval');
    } finally {
      await session.close();
    }
  }, 30000);

  it('rejects pause for a pre-profile v6 run without bypassing its original approval', async () => {
    const f = await fresh(true);
    const legacyContext = f.context;
    const session = await createHarnessSession(
      deps(),
      legacyContext,
      async () => true,
      new AbortController().signal,
    );
    try {
      expect(session.start.protocol).toBe(HARNESS_PROTOCOL_VERSION);
      expect((await f.post('pause', { reason: 'user', purpose: 'none' })).status).toBe(409);
      const args = {
        raw_time_text: legacyContext.inputText,
        timezone_hint: 'Asia/Shanghai',
        note: '喝水',
        occurrence: 'once' as const,
      };
      const reserve = (await session.handleRequest({
        protocol: HARNESS_PROTOCOL_VERSION,
        request_ref: randomUUID(),
        type: 'reserve',
        call_key: 'harness/1',
        tool_id: 'propose_task',
        args,
      })) as { invocation_id: string };
      const outcome = (await session.handleRequest({
        protocol: HARNESS_PROTOCOL_VERSION,
        request_ref: randomUUID(),
        type: 'invoke',
        invocation_id: reserve.invocation_id,
        tool_id: 'propose_task',
        args,
      })) as { result: { approval: { approvalId: string } } };
      const approvalId = outcome.result.approval.approvalId;
      const snapshot = {
        version: 2 as const,
        message_refs: [legacyContext.userMessageId],
        tool_refs: [reserve.invocation_id],
        next_call_no: 2,
        usage: { iterations: 1, tokens: null },
        waiting: { invocation_id: reserve.invocation_id, approval_id: approvalId },
      };
      const checkpoint = (await session.handleRequest({
        protocol: HARNESS_PROTOCOL_VERSION,
        request_ref: randomUUID(),
        type: 'snapshot',
        context: snapshot,
      })) as { checkpoint_ref: string };
      await session.handleRequest({
        protocol: HARNESS_PROTOCOL_VERSION,
        request_ref: randomUUID(),
        type: 'suspend',
        checkpoint_ref: checkpoint.checkpoint_ref,
        invocation_id: reserve.invocation_id,
        approval_id: approvalId,
      });
      expect((await f.post('pause', { reason: 'user', purpose: 'none' })).status).toBe(409);
      expect((await f.post('continue', { pause_id: checkpoint.checkpoint_ref })).status).toBe(409);
      const resume = { checkpoint_id: checkpoint.checkpoint_ref, idempotency_key: randomUUID() };
      expect((await f.post('resume', resume)).status).toBe(409);
      expect(
        (await database.pool.query('SELECT state FROM approvals WHERE id=$1', [approvalId])).rows[0]
          ?.state,
      ).toBe('pending');
      await rejectApproval({ pool: database.pool }, f.actor.userId, approvalId, {
        idempotency_key: randomUUID(),
      });
      const resumed = await resumeConversationRun(
        deps(),
        f.actor.userId,
        f.started.conversationId,
        f.started.runId,
        randomUUID(),
        resume,
      );
      expect(resumed.runId).toBe(f.started.runId);
      expect(resumed.context?.resumeCheckpointId).toBe(checkpoint.checkpoint_ref);
      expect(
        (
          await database.pool.query('SELECT payload FROM run_checkpoints WHERE id=$1', [
            checkpoint.checkpoint_ref,
          ])
        ).rows[0]?.payload,
      ).toEqual(snapshot);
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int n FROM tool_invocations WHERE run_id=$1',
            [f.started.runId],
          )
        ).rows[0]?.n,
      ).toBe(1);
    } finally {
      await session.close();
    }
  }, 30000);

  it('does not confirm a pause after an in-flight nontransactional effect becomes unknown', async () => {
    const f = await fresh();
    const session = await createHarnessSession(
      deps(),
      f.context,
      async () => true,
      new AbortController().signal,
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const reserved = await reserveInvocation(database.pool, f.context, {
        callKey: 'harness/1',
        toolId: 'list_tasks',
        args: {},
        executionKind: 'non_transactional',
      });
      const execution = executeNonTransactionalInvocation(
        database.pool,
        f.context,
        { invocationId: reserved.invocationId, toolId: 'list_tasks', args: {} },
        {
          execute: async () => {
            entered.resolve();
            await release.promise;
            throw new Error('lost effect response');
          },
        },
      );
      await entered.promise;
      const requested = await f.post('pause', { reason: 'user', purpose: 'none' });
      expect(requested.status).toBe(200);
      const { pause_id } = ((await requested.json()) as { data: { pause_id: string } }).data;
      release.resolve();
      expect((await execution).status).toBe('unknown');
      await expect(
        session.handleRequest({
          protocol: HARNESS_R3_PROTOCOL_VERSION,
          request_ref: randomUUID(),
          type: 'pause_point',
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
      ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
      expect(
        (
          await database.pool.query('SELECT state FROM tool_invocations WHERE invocation_id=$1', [
            reserved.invocationId,
          ])
        ).rows[0]?.state,
      ).toBe('unknown');
      expect(
        (await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [f.started.runId]))
          .rows[0]?.status,
      ).not.toBe('paused');
      expect(
        (await database.pool.query('SELECT state FROM harness_pauses WHERE id=$1', [pause_id]))
          .rows[0]?.state,
      ).not.toBe('paused');
      expect((await f.post('continue', { pause_id })).status).toBe(409);
      await session.handleRequest({
        protocol: HARNESS_R3_PROTOCOL_VERSION,
        request_ref: randomUUID(),
        type: 'finish',
        outcome: 'failed',
        usage: { iterations: 0, tokens: 0 },
        error: { code: 'TOOL_EFFECT_UNKNOWN', message: '工具效果尚未确认；不会自动再次执行。' },
      });
      expect(
        (await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [f.started.runId]))
          .rows[0]?.status,
      ).toBe('failed');
      const failed = await database.pool.query(
        `SELECT c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
         WHERE a.run_id=$1 AND c.kind='thread.failed'`,
        [f.started.runId],
      );
      expect(failed.rows[0]?.payload).toMatchObject({
        payload: { error: { code: 'TOOL_EFFECT_UNKNOWN' } },
      });
      expect(
        (
          await database.pool.query('SELECT state FROM tool_invocations WHERE invocation_id=$1', [
            reserved.invocationId,
          ])
        ).rows[0]?.state,
      ).toBe('unknown');
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int n FROM tool_invocations WHERE run_id=$1',
            [f.started.runId],
          )
        ).rows[0]?.n,
      ).toBe(1);
    } finally {
      release.resolve();
      await session.close();
    }
  }, 30000);
});
