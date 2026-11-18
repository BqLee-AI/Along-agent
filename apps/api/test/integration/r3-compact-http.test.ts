import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { z } from 'zod';
import { handleRequest } from '../helpers/http-app.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { measureSdkContext } from '../../src/features/model-providers/public.js';
import { loadHarnessServices } from '../../src/agent/runtime/config.js';
import type { HarnessServices } from '../../src/agent/runtime/contracts.js';
import { createLocalFixtureModelTransport } from '../helpers/local-fixture-model.js';
import { createRunDriver, RunDriver } from '../../src/agent/runtime/run-driver.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import { frames, jsonBody, listen, sendModelSse } from '../helpers/harness-consumer.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const binaryPath = process.env.HARNESS_BINARY;
const suite = databaseUrl && binaryPath ? describe : describe.skip;
type Receipt = {
  status: string;
  run_id: string;
  pause_id: string;
  candidate_status: string;
  error_code?: string;
  candidate_error_code?: string;
};

suite('native server-owned compact over HTTP', () => {
  let db: IntegrationDatabase;
  beforeAll(async () => {
    db = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  async function fixture(
    mode:
      | 'active'
      | 'pending-tool'
      | 'pending-tool-unknown'
      | 'pending-goal'
      | 'idle'
      | 'idle-limited'
      | 'invalid'
      | 'unknown'
      | 'cancel'
      | 'cancel-ignore',
    productionPolicy = false,
  ) {
    const owner = await seedAdmittedSession(db.pool);
    const foreign = await seedAdmittedSession(db.pool);
    await configureTestModel(db.pool, owner.userId, 'fixture-transport-only');
    const conversationId = randomUUID(),
      sourceId = randomUUID();
    await db.pool.query('INSERT INTO conversations(id,owner_id) VALUES($1,$2)', [
      conversationId,
      owner.userId,
    ]);
    await db.pool.query(
      "INSERT INTO messages(id,owner_id,conversation_id,role,content) VALUES($1,$2,$3,'user','Original source: retain this fact.')",
      [sourceId, owner.userId, conversationId],
    );
    const measureEntered = Promise.withResolvers<void>(),
      releaseMeasure = Promise.withResolvers<void>();
    const releaseCompact = Promise.withResolvers<void>();
    const compactEntered = Promise.withResolvers<void>();
    const compactAborted = Promise.withResolvers<void>();
    const releaseLateCompact = Promise.withResolvers<void>();
    const continuationEntered = Promise.withResolvers<void>(),
      releaseContinuation = Promise.withResolvers<void>();
    let measureCalls = 0,
      compactCalls = 0,
      taskCalls = 0,
      compactReady = false;
    let modelError: unknown;
    const requests: unknown[] = [];
    const modelServer = createServer((req, res) => {
      void (async () => {
        const body = (await jsonBody(req)) as {
          messages: Array<{ role: string; content: string }>;
          max_tokens?: number;
        };
        requests.push(body);
        const system = body.messages.find((message) => message.role === 'system')?.content ?? '';
        if (system.includes('producing a compact, untrusted historical summary')) {
          compactCalls++;
          const input = JSON.parse(
            body.messages.find((message) => message.role === 'user')!.content,
          ) as {
            previous: { coverage: Array<{ sequence: number; id: string }> } | null;
            messages: Array<{ sequence: number; id: string }>;
          };
          const coverage = [
            ...(input.previous?.coverage ?? []),
            ...input.messages.map(({ sequence, id }) => ({ sequence, id })),
          ].sort((a, b) => a.sequence - b.sequence);
          compactReady = true;
          await releaseCompact.promise;
          if (res.destroyed) return;
          if (mode === 'idle-limited' && (body.max_tokens ?? 0) < 4096) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`,
            );
            res.end('data: [DONE]\n\n');
            return;
          }
          const content =
            mode === 'invalid'
              ? 'not JSON'
              : JSON.stringify({
                  text: 'Summary of original source.',
                  coverage,
                  candidates:
                    mode === 'active'
                      ? [{ content: 'Invalid candidate', messageIds: [randomUUID()] }]
                      : [],
                });
          sendModelSse(res, {
            message: { content, tool_calls: [] },
            usage: mode === 'unknown' ? null : { total_tokens: 5 },
          });
          return;
        }
        taskCalls++;
        if (taskCalls === 1) {
          continuationEntered.resolve();
          await releaseContinuation.promise;
        }
        if (res.destroyed) return;
        sendModelSse(res, {
          message: {
            content: null,
            tool_calls: [
              {
                id: `task-${taskCalls}`,
                type: 'function',
                function:
                  taskCalls === 1 && mode !== 'pending-goal'
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
          usage: taskCalls === 1 && mode === 'pending-tool-unknown' ? null : { total_tokens: 5 },
        });
      })().catch((error) => {
        modelError = error;
        res.destroy();
      });
    });
    const modelBase = await listen(modelServer);
    const driver =
      mode === 'cancel' || mode === 'cancel-ignore'
        ? new RunDriver(new Pool({ ...db.pool.options, max: 2 }), 1)
        : createRunDriver(db.pool);
    const upstream = createLocalFixtureModelTransport({
      baseUrl: `${modelBase}/v1`,
      model: 'fixture-transport-only',
    });
    let stalled = false;
    const model: HarnessServices['model'] = async function* (request, tools, signal) {
      if ((mode !== 'cancel' && mode !== 'cancel-ignore') || stalled) {
        yield* upstream(request, tools, signal);
        return;
      }
      stalled = true;
      compactEntered.resolve();
      signal.addEventListener('abort', () => compactAborted.resolve(), { once: true });
      if (signal.aborted) compactAborted.resolve();
      if (mode === 'cancel') {
        await compactAborted.promise;
        return;
      }
      await releaseLateCompact.promise;
      const input = JSON.parse(request.messages[1]!.content!) as {
        messages: Array<{ id: string; sequence: number }>;
      };
      yield {
        type: 'complete',
        reply: {
          message: {
            content: JSON.stringify({
              text: 'Late summary',
              coverage: input.messages.map(({ id, sequence }) => ({ id, sequence })),
              candidates: [],
            }),
            tool_calls: [],
          },
          usage: { total_tokens: 37 },
        },
      };
    };
    const deps = {
      pool: db.pool,
      timeContext: loadTimeContext('fixture-v1'),
      runDriver: driver,
      harness: {
        binaryPath: binaryPath!,
        libraryPath: process.env.HARNESS_LIBRARY_PATH,
        maxIterations: 8,
        maxTokens: 8000,
        ...(mode === 'idle-limited' ? { compactCompletionCap: 4096 } : {}),
        contextPolicy: productionPolicy
          ? loadHarnessServices({
              HARNESS_BINARY: process.execPath,
              HARNESS_COMPLETION_CAP: '1024',
            })!.contextPolicy
          : createContextPolicy({
              completionCap: 1024,
              model: 'fixture-transport-only',
            }),
        model,
        measure: async (...args: Parameters<typeof measureSdkContext>) => {
          if (mode === 'active' && ++measureCalls === 1) {
            measureEntered.resolve();
            await releaseMeasure.promise;
          }
          return measureSdkContext(...args);
        },
      },
    };
    controlledModelDeps(deps);
    const api = createServer((req, res) => {
      void handleRequest(req, res, deps).catch(() => res.destroy());
    });
    const base = await listen(api);
    const headers = {
      cookie: `better-auth.session_token=${owner.token}`,
      'x-csrf-token': owner.csrfToken,
    };
    const foreignHeaders = {
      cookie: `better-auth.session_token=${foreign.token}`,
      'x-csrf-token': foreign.csrfToken,
    };
    const post = (path: string, body: unknown, key: string, auth = headers) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      });
    const get = (path: string, auth = headers) => fetch(`${base}${path}`, { headers: auth });
    const receipt = async (response: Response): Promise<Receipt> => {
      expect(response.status).toBe(200);
      return ((await response.json()) as { data: Receipt }).data;
    };
    // HTTP reads are the synchronization point; no wall-clock sleep or presumed scheduling order.
    const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const value = await read();
        if (done(value)) return value;
      }
      throw new Error('timed out waiting for durable HTTP state');
    };
    const waitCompact = async (path: string, pauseId: string) => {
      const state = await until(
        async () => {
          const response = await get(`${path}/compacts/${pauseId}`);
          const body = await response.text();
          return { status: response.status, body, ready: compactReady, modelError };
        },
        (value) =>
          value.ready ||
          value.modelError !== undefined ||
          value.status !== 200 ||
          /\"status\":\"(?:failed|cancelled)\"/.test(value.body),
      );
      if (!state.ready) {
        const facts = await db.pool.query(
          `SELECT r.status AS run_status,r.frozen_context,a.status AS attempt_status,
          p.state AS pause_state,p.snapshot,o.status AS operation_status,o.call_started,o.freeze_id
          FROM compact_operations o JOIN harness_pauses p ON p.id=o.pause_id
          JOIN run_attempts a ON a.id=o.attempt_id JOIN agent_runs r ON r.id=o.run_id
          WHERE o.pause_id=$1`,
          [pauseId],
        );
        const terminal = await db.pool.query(
          `SELECT c.kind,c.payload FROM run_checkpoints c
          JOIN run_attempts a ON a.id=c.attempt_id WHERE a.run_id=(SELECT run_id FROM compact_operations WHERE pause_id=$1)
          ORDER BY c.created_at`,
          [pauseId],
        );
        throw new Error(
          `compact model not reached: ${JSON.stringify({ ...state, facts: facts.rows, terminal: terminal.rows })}`,
        );
      }
    };
    const close = async () => {
      releaseMeasure.resolve();
      releaseCompact.resolve();
      releaseContinuation.resolve();
      releaseLateCompact.resolve();
      await driver.shutdown();
      for (const server of [api, modelServer]) {
        const closed = once(server, 'close');
        server.closeAllConnections();
        server.close();
        await closed;
      }
    };
    return {
      owner,
      conversationId,
      sourceId,
      foreignHeaders,
      post,
      get,
      receipt,
      until,
      waitCompact,
      close,
      measureEntered,
      releaseMeasure,
      releaseCompact,
      compactEntered,
      compactAborted,
      releaseLateCompact,
      continuationEntered,
      releaseContinuation,
      requests,
      counts: () => ({ compact: compactCalls, task: taskCalls }),
    };
  }
  it('freezes an estimated fallback for a normal selected model without window configuration', async () => {
    const f = await fixture('active', true);
    try {
      const started = await f.post(
        '/api/v1/conversations/messages',
        {
          conversation_id: f.conversationId,
          execution: 'harness',
          authorization_revision: 'delegation/1',
          raw_text: 'Continue the conversation.',
        },
        randomUUID(),
      );
      expect(started.status).toBe(200);
      const runId = started.headers.get('x-run-id')!;
      const row = (
        await db.pool.query('SELECT frozen_context FROM agent_runs WHERE id=$1', [runId])
      ).rows[0];
      expect(row.frozen_context.autoCompactPolicy).toMatchObject({
        evidenceId: 'application-envelope-estimate/1',
        model: 'fixture-transport-only',
        triggerRatio: 0.8,
        meterRevision: 'openai-json-utf8-estimate/1',
      });
      const policy = await db.pool.query(
        'SELECT policy FROM run_context_policies WHERE run_id=$1',
        [runId],
      );
      expect(policy.rows[0].policy).toMatchObject({
        model_window_tokens: null,
        input_meter: 'estimated',
        model_binding: { model: 'fixture-transport-only' },
      });
    } finally {
      await f.close();
    }
  }, 45000);

  it('continues the same active Run once, retaining sources and reporting candidate failure', async () => {
    const f = await fixture('active');
    try {
      const started = await f.post(
        '/api/v1/conversations/messages',
        {
          conversation_id: f.conversationId,
          execution: 'harness',
          authorization_revision: 'delegation/1',
          raw_text: 'Please read my preferences and answer.',
        },
        randomUUID(),
      );
      expect(started.status).toBe(200);
      const runId = started.headers.get('x-run-id')!;
      expect(runId).toMatch(/^[0-9a-f-]{36}$/i);
      await f.measureEntered.promise;
      const path = `/api/v1/conversations/${f.conversationId}/runs/${runId}`;
      const key = randomUUID();
      expect((await f.post(`${path}/actions/compact`, {}, key, f.foreignHeaders)).status).toBe(404);
      const first = await f.receipt(await f.post(`${path}/actions/compact`, {}, key));
      expect(first).toMatchObject({ status: 'pending', run_id: runId });
      const replay = await f.receipt(await f.post(`${path}/actions/compact`, {}, key));
      expect(replay.pause_id).toBe(first.pause_id);
      expect(f.counts()).toEqual({ compact: 0, task: 0 });
      f.releaseMeasure.resolve();
      await f.waitCompact(path, first.pause_id);
      expect((await f.receipt(await f.post(`${path}/actions/compact`, {}, key))).pause_id).toBe(
        first.pause_id,
      );
      expect(f.counts()).toEqual({ compact: 1, task: 0 });
      f.releaseCompact.resolve();
      await f.continuationEntered.promise;
      const final = await f.until(
        async () => f.receipt(await f.get(`${path}/compacts/${first.pause_id}`)),
        (r) => r.status === 'continued' || r.status === 'failed',
      );
      expect(final).toMatchObject({
        status: 'continued',
        run_id: runId,
        pause_id: first.pause_id,
        candidate_status: 'failed',
        candidate_error_code: 'COMPACT_INVALID_CANDIDATES',
      });
      const source = await db.pool.query(
        `SELECT s.message_id FROM compact_summary_sources s
        JOIN compact_summaries c ON c.id=s.summary_id
        WHERE c.owner_id=$1 AND c.conversation_id=$2`,
        [f.owner.userId, f.conversationId],
      );
      expect(source.rows).toContainEqual({ message_id: f.sourceId });
      const policy = await db.pool.query(
        'SELECT policy FROM run_context_policies WHERE owner_id=$1 AND run_id=$2',
        [f.owner.userId, runId],
      );
      expect(policy.rows[0]?.policy.input_meter).toBe('unavailable');
      const eventsResponse = await f.get(`${path}/events`);
      expect(eventsResponse.status).toBe(200);
      f.releaseContinuation.resolve();
      const events = frames(await eventsResponse.text());
      expect(events.at(-1)?.type).toBe('thread.completed');
      expect(await f.receipt(await f.post(`${path}/actions/compact`, {}, key))).toEqual(final);
      expect(f.counts()).toEqual({ compact: 1, task: 2 });
      const attempts = await db.pool.query('SELECT id FROM run_attempts WHERE run_id=$1', [runId]);
      expect(attempts.rowCount).toBe(2);
      const tools = await db.pool.query(
        "SELECT state FROM tool_invocations WHERE run_id=$1 AND tool_id='get_user_prefs'",
        [runId],
      );
      expect(tools.rows).toEqual([{ state: 'completed' }]);
      expect(JSON.stringify(f.requests)).toContain('Summary of original source.');
      const messages = await db.pool.query(
        'SELECT id,content FROM messages WHERE owner_id=$1 AND conversation_id=$2 ORDER BY created_at,id',
        [f.owner.userId, f.conversationId],
      );
      expect(messages.rows).toContainEqual({
        id: f.sourceId,
        content: 'Original source: retain this fact.',
      });
      expect(messages.rows.some((row) => row.content === '/compact')).toBe(false);
    } finally {
      await f.close();
    }
  }, 45000);

  for (const mode of ['pending-tool', 'pending-tool-unknown', 'pending-goal'] as const) {
    it(`compacts an accepted ${mode} response without replaying it or executing it before the pause`, async () => {
      const f = await fixture(mode);
      try {
        const started = await f.post(
          '/api/v1/conversations/messages',
          {
            conversation_id: f.conversationId,
            execution: 'harness',
            authorization_revision: 'delegation/1',
            raw_text: 'Please read my preferences and answer.',
          },
          randomUUID(),
        );
        expect(started.status).toBe(200);
        const runId = started.headers.get('x-run-id')!;
        const path = `/api/v1/conversations/${f.conversationId}/runs/${runId}`;
        await f.continuationEntered.promise;
        const receipt = await f.receipt(await f.post(`${path}/actions/compact`, {}, randomUUID()));
        expect(receipt.status).toBe('pending');
        f.releaseContinuation.resolve();
        await f.waitCompact(path, receipt.pause_id);
        const paused = (
          await db.pool.query('SELECT snapshot FROM harness_pauses WHERE id=$1', [receipt.pause_id])
        ).rows[0].snapshot;
        expect(paused.native_state.pending_model.tool_calls[0].function.name).toBe(
          mode === 'pending-goal' ? 'finish_goal' : 'get_user_prefs',
        );
        expect(paused.usage).toEqual({
          iterations: 1,
          tokens: mode === 'pending-tool-unknown' ? null : 5,
        });
        expect(
          (await db.pool.query('SELECT 1 FROM tool_invocations WHERE run_id=$1', [runId])).rowCount,
        ).toBe(0);
        expect(f.counts()).toEqual({ compact: 1, task: 1 });
        f.releaseCompact.resolve();
        const final = await f.until(
          async () => f.receipt(await f.get(`${path}/compacts/${receipt.pause_id}`)),
          (value) => value.status === 'continued' || value.status === 'failed',
        );
        expect(final.status).toBe('continued');
        const continuation = (
          await db.pool.query('SELECT snapshot FROM compact_continuations WHERE pause_id=$1', [
            receipt.pause_id,
          ])
        ).rows[0].snapshot;
        expect(continuation.native_state.pending_model).toEqual(paused.native_state.pending_model);
        expect(continuation.usage).toEqual({
          iterations: 2,
          tokens: mode === 'pending-tool-unknown' ? null : 10,
        });
        const events = frames(await (await f.get(`${path}/events`)).text());
        expect(events.at(-1)?.type).toBe('thread.completed');
        expect(f.counts()).toEqual({ compact: 1, task: mode === 'pending-goal' ? 1 : 2 });
        const tools = await db.pool.query(
          "SELECT state FROM tool_invocations WHERE run_id=$1 AND tool_id='get_user_prefs'",
          [runId],
        );
        expect(tools.rows).toEqual(mode === 'pending-goal' ? [] : [{ state: 'completed' }]);
      } finally {
        await f.close();
      }
    }, 45000);
  }

  it('cancels a pending tool response during compact without executing or replaying it', async () => {
    const f = await fixture('pending-tool');
    try {
      const started = await f.post(
        '/api/v1/conversations/messages',
        {
          conversation_id: f.conversationId,
          execution: 'harness',
          authorization_revision: 'delegation/1',
          raw_text: 'Please read my preferences and answer.',
        },
        randomUUID(),
      );
      const runId = started.headers.get('x-run-id')!;
      const path = `/api/v1/conversations/${f.conversationId}/runs/${runId}`;
      await f.continuationEntered.promise;
      const receipt = await f.receipt(await f.post(`${path}/actions/compact`, {}, randomUUID()));
      f.releaseContinuation.resolve();
      await f.waitCompact(path, receipt.pause_id);
      expect(
        (await f.post(`${path}/actions/cancel`, { idempotency_key: randomUUID() }, randomUUID()))
          .status,
      ).toBe(200);
      f.releaseCompact.resolve();
      const final = await f.until(
        async () => f.receipt(await f.get(`${path}/compacts/${receipt.pause_id}`)),
        (value) => value.status === 'cancelled',
      );
      expect(final.status).toBe('cancelled');
      expect(
        (await db.pool.query('SELECT 1 FROM tool_invocations WHERE run_id=$1', [runId])).rowCount,
      ).toBe(0);
      expect(f.counts()).toEqual({ compact: 1, task: 1 });
    } finally {
      await f.close();
    }
  }, 45000);

  for (const mode of ['cancel', 'cancel-ignore'] as const) {
    it(`bounds cancelled compact transport work in ${mode} mode`, async () => {
      const f = await fixture(mode);
      try {
        const path = `/api/v1/conversations/${f.conversationId}`;
        const first = await f.receipt(await f.post(`${path}/actions/compact`, {}, randomUUID()));
        await f.compactEntered.promise;
        const firstPath = `${path}/runs/${first.run_id}`;
        const cancelled = await f.post(
          `${firstPath}/actions/cancel`,
          { idempotency_key: randomUUID() },
          randomUUID(),
        );
        expect(cancelled.status).toBe(200);
        const cancelledView = z
          .object({ data: z.object({ status: z.string() }) })
          .parse(await cancelled.json());
        expect(cancelledView.data.status).toBe('cancelled');
        await f.compactAborted.promise;

        const nextKey = randomUUID();
        if (mode === 'cancel-ignore') {
          // The cancelled provider has not stopped, so it must still occupy the sole slot.
          expect((await f.post(`${path}/actions/compact`, {}, nextKey)).status).toBe(409);
          f.releaseLateCompact.resolve();
        }
        const usage = await f.until(
          async () =>
            (
              await db.pool.query<{ usage_recorded: boolean; usage_tokens: string | null }>(
                'SELECT usage_recorded,usage_tokens::text FROM compact_operations WHERE pause_id=$1',
                [first.pause_id],
              )
            ).rows[0],
          (row) => row?.usage_recorded === true,
        );
        expect(usage?.usage_tokens).toBe(mode === 'cancel-ignore' ? '37' : null);
        expect(
          await f.receipt(await f.get(`${firstPath}/compacts/${first.pause_id}`)),
        ).toMatchObject({ status: 'cancelled' });
        const published = await db.pool.query(
          `SELECT s.id FROM compact_summaries s JOIN compact_freezes f ON f.id=s.freeze_id
           WHERE f.run_id=$1`,
          [first.run_id],
        );
        expect(published.rowCount).toBe(0);

        const nextResponse = await f.until(
          () => f.post(`${path}/actions/compact`, {}, nextKey),
          (response) => response.status !== 409,
        );
        const next = await f.receipt(nextResponse);
        expect(next.run_id).not.toBe(first.run_id);
        await f.waitCompact(`${path}/runs/${next.run_id}`, next.pause_id);
        const compactRequest = f.requests[0] as {
          messages: Array<{ role: string; content: string }>;
        };
        const compactInput = JSON.parse(
          compactRequest.messages.find((message) => message.role === 'user')!.content,
        ) as { previous: unknown };
        expect(compactInput.previous).toBeNull();

        f.releaseCompact.resolve();
        const final = await f.until(
          () => f.get(`${path}/runs/${next.run_id}/compacts/${next.pause_id}`).then(f.receipt),
          (receipt) => receipt.status === 'continued' || receipt.status === 'failed',
        );
        expect(final.status).toBe('continued');
      } finally {
        await f.close();
      }
    }, 45000);
  }

  for (const mode of ['idle', 'idle-limited', 'invalid', 'unknown'] as const) {
    it(`runs idle compact as a control Run and reports ${mode} truthfully`, async () => {
      const f = await fixture(mode);
      try {
        const path = `/api/v1/conversations/${f.conversationId}`;
        const key = randomUUID();
        const first = await f.receipt(await f.post(`${path}/actions/compact`, {}, key));
        expect(first.run_id).toMatch(/^[0-9a-f-]{36}$/i);
        await f.waitCompact(`${path}/runs/${first.run_id}`, first.pause_id);
        const replay = await f.receipt(await f.post(`${path}/actions/compact`, {}, key));
        expect(replay.run_id).toBe(first.run_id);
        expect(replay.pause_id).toBe(first.pause_id);
        expect((await f.post(`${path}/actions/compact`, {}, key, f.foreignHeaders)).status).toBe(
          404,
        );
        expect(
          (await f.get(`${path}/runs/${first.run_id}/compacts/${first.pause_id}`, f.foreignHeaders))
            .status,
        ).toBe(404);
        expect(f.counts()).toEqual({ compact: 1, task: 0 });
        f.releaseCompact.resolve();
        const runPath = `${path}/runs/${first.run_id}`;
        const final = await f.until(
          async () => f.receipt(await f.get(`${runPath}/compacts/${first.pause_id}`)),
          (r) => r.status === 'continued' || r.status === 'failed',
        );
        if (mode === 'idle' || mode === 'idle-limited')
          expect(final).toMatchObject({ status: 'continued', candidate_status: 'saved' });
        else if (mode === 'invalid')
          expect(final).toMatchObject({ status: 'failed', error_code: 'COMPACT_INVALID_RESPONSE' });
        else {
          expect(final.status).toBe('failed');
          expect(final.error_code).toBeTruthy();
          const usage = await db.pool.query(
            'SELECT usage_recorded,usage_tokens FROM compact_operations WHERE pause_id=$1',
            [first.pause_id],
          );
          expect(usage.rows).toEqual([{ usage_recorded: true, usage_tokens: null }]);
          expect(
            (
              await db.pool.query('SELECT id FROM compact_summaries WHERE owner_id=$1', [
                f.owner.userId,
              ])
            ).rowCount,
          ).toBe(0);
        }
        if (mode === 'idle' || mode === 'idle-limited') {
          const source = await db.pool.query(
            `SELECT s.message_id FROM compact_summary_sources s
            JOIN compact_summaries c ON c.id=s.summary_id
            WHERE c.owner_id=$1 AND c.conversation_id=$2`,
            [f.owner.userId, f.conversationId],
          );
          expect(source.rows).toEqual([{ message_id: f.sourceId }]);
        }
        const view = await f.until(
          async () => {
            const response = await f.get(runPath);
            expect(response.status).toBe(200);
            return ((await response.json()) as { data: { status: string } }).data;
          },
          (v) => !['running', 'paused'].includes(v.status),
        );
        expect(view.status).toBe(mode === 'idle' || mode === 'idle-limited' ? 'done' : 'failed');
        expect((await f.receipt(await f.post(`${path}/actions/compact`, {}, key))).run_id).toBe(
          first.run_id,
        );
        expect(f.counts()).toEqual({ compact: 1, task: 0 });
        const runs = await db.pool.query(
          'SELECT id,input_message_id FROM agent_runs WHERE owner_id=$1 AND conversation_id=$2',
          [f.owner.userId, f.conversationId],
        );
        expect(runs.rows).toEqual([{ id: first.run_id, input_message_id: null }]);
        const messages = await db.pool.query(
          'SELECT id,content FROM messages WHERE owner_id=$1 AND conversation_id=$2',
          [f.owner.userId, f.conversationId],
        );
        expect(messages.rows).toEqual([
          { id: f.sourceId, content: 'Original source: retain this fact.' },
        ]);
      } finally {
        await f.close();
      }
    }, 45000);
  }
});
