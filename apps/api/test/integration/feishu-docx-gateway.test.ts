import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { HARNESS_PROTOCOL_VERSION } from '@along/contracts';
import { cancelConversationRun, getRunView } from '../../src/agent/operations/run.js';
import { createHarnessSession } from '../../src/agent/runtime/attempt-session.js';
import { loadHarnessSession } from '../../src/agent/runtime/attempt-load.js';
import { createModelHandlers } from '../../src/agent/runtime/attempt-model.js';
import type { AttemptState } from '../../src/agent/runtime/attempt-state.js';
import type { ConversationDeps, RunContext } from '../../src/agent/runtime/contracts.js';
import { RunOwnership } from '../../src/agent/runtime/run-ownership.js';
import { withTransaction } from '../../src/db/transaction.js';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import {
  createContextPolicy,
  listRunEvents,
  lockRun,
} from '../../src/features/conversations/public.js';
import {
  createConfiguredSdkStep,
  measureSdkContext,
} from '../../src/features/model-providers/public.js';
import { loadTimeContext } from '../../src/features/time/public.js';
import { configureTestModel } from '../helpers/model-selection.js';
import { createIntegrationDatabase, databaseUrl, seedAdmittedSession } from './setup.js';

const run = databaseUrl ? test : test.skip;
run(
  'only a new linked Run can read the specified Docx, and disconnect blocks replay',
  async () => {
    const db = await createIntegrationDatabase();
    const env = {
      APP_ORIGIN: 'http://localhost:3000',
      FEISHU_BOT_DOCX_CONFIG: '',
      FEISHU_BOT_DOCX_APP_SECRET: 'synthetic',
      FEISHU_BOT_DOCX_OBSERVATION_KEY: Buffer.alloc(32, 9).toString('base64'),
    };
    const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, env);
    const fetchBefore = globalThis.fetch;
    const docId = 'TestDocument000000000000000';
    const url = `https://test.feishu.cn/docx/${docId}`;
    const content = 'Synthetic planning note; not to be stored unencrypted.';
    let upstreamDenied = false;
    let beforeRawContent: (() => Promise<void>) | undefined;
    const calls: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const target = new URL(String(input));
        calls.push(target.pathname);
        if (target.pathname === '/open-apis/auth/v3/tenant_access_token/internal')
          return Response.json({ code: 0, tenant_access_token: 'synthetic-token', expire: 3600 });
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
        expect(target.origin).toBe('https://open.feishu.cn');
        const metadata = `/open-apis/docx/v1/documents/${docId}`;
        if (upstreamDenied) return Response.json({ code: 1770032 }, { status: 403 });
        if (target.pathname === metadata)
          return Response.json({
            code: 0,
            data: { document: { document_id: docId, revision_id: 6, title: 'Fixture' } },
          });
        if (target.pathname === `${metadata}/raw_content`) {
          await beforeRawContent?.();
          return Response.json({ code: 0, data: { content } });
        }
        throw new Error('unexpected provider request');
      },
      { preconnect: fetchBefore.preconnect },
    );
    try {
      const session = await seedAdmittedSession(db.pool);
      const viewer = { ownerId: session.userId, sessionId: session.sessionId };
      await configureTestModel(db.pool, viewer.ownerId, 'fixture');
      const deps = {
        pool: db.pool,
        timeContext: loadTimeContext('fixture-v1'),
        harness: {
          binaryPath: '/unused',
          maxIterations: 10,
          maxTokens: 8000,
          contextPolicy: createContextPolicy({ completionCap: 512, model: 'fixture' }),
        },
      };
      async function admit(text: string) {
        const { context } = await startConversationRun(
          deps,
          viewer.ownerId,
          randomUUID(),
          {
            execution: 'harness',
            authorization_revision: 'delegation/1',
            raw_text: text,
          },
          null,
          viewer.sessionId,
        );
        if (!context) throw new Error('missing Run context');
        return context;
      }
      const old = await admit(`Read ${url}`);
      expect(old.allowlist).not.toContain('feishu_docx_read');
      const appId = 'cli_testtesttesttest';
      process.env.FEISHU_BOT_DOCX_CONFIG = JSON.stringify({
        appId,
        ownerId: viewer.ownerId,
        connectionId: randomUUID(),
        revision: randomUUID(),
        secretEnv: 'FEISHU_BOT_DOCX_APP_SECRET',
        observationKeyEnv: 'FEISHU_BOT_DOCX_OBSERVATION_KEY',
        documents: [url],
      });
      const generation = randomUUID();
      const connect = () =>
        db.pool.query(
          `INSERT INTO feishu_bot_connections(owner_id,attempt_id,expires_at,app_id,bot_name)
           VALUES($1,$2,now(),$3,'Synthetic')`,
          [viewer.ownerId, generation, appId],
        );
      const disconnect = async () => {
        await db.pool.query('DELETE FROM feishu_bot_connections WHERE owner_id=$1', [
          viewer.ownerId,
        ]);
      };
      await connect();
      const fresh = await admit(`Read ${url}`);
      expect(fresh.allowlist).toContain('feishu_docx_read');
      expect(fresh.allowlist).not.toContain('remember_memory');
      expect(fresh.allowlist).not.toContain('workspace_create');
      const toolId = 'feishu_docx_read';
      const args = {};
      await expect(
        reserveToolInvocation(db.pool, old, { callKey: 'harness/1', toolId, args }),
      ).rejects.toThrow();
      const invalidArgs = { url };
      const invalid = await reserveToolInvocation(db.pool, fresh, {
        callKey: 'harness/1',
        toolId,
        args: invalidArgs,
      });
      expect(
        await invokeTool(db.pool, fresh, { ...invalid, toolId, args: invalidArgs }),
      ).toMatchObject({ status: 'denied', error: { code: 'TOOL_INPUT_INVALID' } });
      expect(calls).toHaveLength(0);
      const slot = await reserveToolInvocation(db.pool, fresh, {
        callKey: 'harness/2',
        toolId,
        args,
      });
      const result = await invokeTool(db.pool, fresh, { ...slot, toolId, args });
      expect(result).toMatchObject({
        status: 'ok',
        result: {
          kind: toolId,
          source: { url },
          revision: { before: 6, after: 6 },
          completeness: 'complete_plain_text',
          content,
        },
      });
      const receipt = await db.pool.query(
        'SELECT accepted_result FROM tool_invocations WHERE invocation_id=$1',
        [slot.invocationId],
      );
      expect(receipt.rows[0]?.accepted_result).toMatchObject({ encoding: 'feishu-aead/2' });
      expect(JSON.stringify(receipt.rows)).not.toContain(content);
      const audit = await db.pool.query('SELECT * FROM tool_calls WHERE invocation_id=$1', [
        slot.invocationId,
      ]);
      expect(JSON.stringify(audit.rows)).not.toContain(content);
      upstreamDenied = true;
      const count = calls.length;
      expect((await invokeTool(db.pool, fresh, { ...slot, toolId, args })).replayed).toBe(true);
      expect(calls).toHaveLength(count);
      delete process.env.FEISHU_BOT_DOCX_OBSERVATION_KEY;
      expect(await invokeTool(db.pool, fresh, { ...slot, toolId, args })).toMatchObject({
        status: 'denied',
        error: { code: 'TOOL_FORBIDDEN' },
      });
      expect(calls).toHaveLength(count);
      expect(
        (
          await db.pool.query(
            'SELECT accepted_result FROM tool_invocations WHERE invocation_id=$1',
            [slot.invocationId],
          )
        ).rows,
      ).toEqual(receipt.rows);
      process.env.FEISHU_BOT_DOCX_OBSERVATION_KEY = env.FEISHU_BOT_DOCX_OBSERVATION_KEY;
      expect((await invokeTool(db.pool, fresh, { ...slot, toolId, args })).replayed).toBe(true);
      const deniedSlot = await reserveToolInvocation(db.pool, fresh, {
        callKey: 'harness/3',
        toolId,
        args,
      });
      expect(await invokeTool(db.pool, fresh, { ...deniedSlot, toolId, args })).toMatchObject({
        status: 'denied',
        error: { code: 'FEISHU_DOCX_PERMISSION_DENIED' },
      });
      expect(calls.length).toBeGreaterThan(count);
      const noPrivateReceipt = await admit(`Read ${url}`);
      const unshared = await reserveToolInvocation(db.pool, noPrivateReceipt, {
        callKey: 'harness/1',
        toolId,
        args,
      });
      expect(
        await invokeTool(db.pool, noPrivateReceipt, { ...unshared, toolId, args }),
      ).toMatchObject({ status: 'denied', error: { code: 'FEISHU_DOCX_PERMISSION_DENIED' } });

      let modelCalls = 0;
      const modelName = 'fixture';
      const sdk = createConfiguredSdkStep(
        { baseUrl: 'https://model.invalid/v1', model: modelName },
        async () => {
          modelCalls++;
          return new Response(null, { status: 502 });
        },
      );
      const modelDeps: ConversationDeps = {
        ...deps,
        modelTransport: async () => ({
          measure: measureSdkContext,
          model: async function* (request, tools, signal, authorizeDispatch) {
            // The scheduler already authorized the dispatch at this point; simulate the
            // configuration changing while the provider prepares the outbound request.
            const config = process.env.FEISHU_BOT_DOCX_CONFIG!;
            delete process.env.FEISHU_BOT_DOCX_CONFIG;
            try {
              yield* sdk(request, tools, signal, authorizeDispatch);
            } finally {
              process.env.FEISHU_BOT_DOCX_CONFIG = config;
            }
          },
        }),
      };
      async function dispatchModel(context: RunContext, text: string) {
        const initial = await loadHarnessSession(db.pool, modelDeps, context);
        const state: AttemptState = {
          stopped: false,
          correctingGoal: false,
          lastSnapshot: initial.snapshot,
          delivered: new Set(),
          cumulative: { iterations: 0, tokens: 0 },
          facts: null,
          embedding: null,
          encodingCount: 0,
          encodingPending: false,
          routingDecision: initial.decision,
          modelStarted: false,
          latestModelMessage: null,
          modelToolCount: 0,
          nextPermit: true,
          lastMeasurement: null,
          modelStream: null,
        };
        const session = new AbortController();
        const model = new AbortController();
        return createModelHandlers({
          pool: db.pool,
          deps: modelDeps,
          context,
          initial,
          state,
          tools: [],
          guarded: (fn) =>
            withTransaction(db.pool, async (client) => fn(client, await lockRun(client, context))),
          assertActionAuthority: async () => undefined,
          sessionSignal: session.signal,
          modelSignal: model.signal,
          modelController: model,
        }).model({
          protocol: HARNESS_PROTOCOL_VERSION,
          type: 'model',
          request_ref: 'm1',
          messages: [{ role: 'user', content: text }],
          remaining_tokens: context.maxTokens,
          max_output_tokens: 32,
        });
      }
      expect(await dispatchModel(fresh, content)).toMatchObject({ type: 'failed', usage: null });
      expect(modelCalls).toBe(0);
      // A Run without a private receipt can still dispatch, including to explain a denied read.
      expect(await dispatchModel(old, 'ordinary request')).toMatchObject({
        type: 'failed',
        usage: null,
      });
      expect(modelCalls).toBe(1);
      expect(await dispatchModel(noPrivateReceipt, 'report the upstream denial')).toMatchObject({
        type: 'failed',
        usage: null,
      });
      expect(modelCalls).toBe(2);

      upstreamDenied = false;
      // Drive the same acknowledged output frames as the native process. A real
      // ownership transaction provides an exact barrier immediately after commit.
      const delivered = 'Previously delivered synthetic excerpt. ';
      for (const type of ['answer', 'finish_goal'] as const) {
        for (const afterCommit of [false, true]) {
          const context = await admit(`Read ${url}`);
          const accepted = await reserveToolInvocation(db.pool, context, {
            callKey: 'harness/1',
            toolId,
            args,
          });
          expect(await invokeTool(db.pool, context, { ...accepted, toolId, args })).toMatchObject({
            status: 'ok',
          });
          const ownership = await RunOwnership.tryAcquire(db.pool, context.runId);
          if (!ownership) throw new Error('fixture ownership unavailable');
          try {
            const published: unknown[] = [];
            const session = await createHarnessSession(
              {
                ...deps,
                modelTransport: async () => ({
                  measure: measureSdkContext,
                  model: async function* (_request, _tools, _signal, authorizeDispatch) {
                    await authorizeDispatch?.();
                    yield { type: 'delta', delta: delivered };
                    if (type === 'answer') yield { type: 'delta', delta: content };
                    yield {
                      type: 'complete',
                      reply: { message: { content, tool_calls: [] }, usage: null },
                    };
                  },
                }),
              },
              { ...context, ownership },
              async (event) => {
                published.push(event);
                return true;
              },
              new AbortController().signal,
            );
            const frame = () => ({ protocol: session.start.protocol, request_ref: randomUUID() });
            try {
              await session.handleRequest({ ...frame(), type: 'pause_probe' });
              const model = {
                ...frame(),
                type: 'model' as const,
                messages: [{ role: 'user' as const, content }],
                remaining_tokens: context.maxTokens,
                max_output_tokens: 32,
              };
              expect(await session.handleRequest(model)).toEqual({
                type: 'delta',
                delta: delivered,
              });
              expect(
                await session.handleRequest({ ...frame(), type: 'answer', delta: delivered }),
              ).toEqual({ accepted: true });
              expect(
                await session.handleRequest({
                  ...frame(),
                  type: 'model_next',
                  model_ref: model.request_ref,
                }),
              ).toMatchObject({ type: type === 'answer' ? 'delta' : 'complete' });
              if (afterCommit) {
                const transaction = ownership.transaction.bind(ownership);
                ownership.transaction = async (action) => {
                  const committed = await transaction(action);
                  if (committed && typeof committed === 'object' && 'privateOutput' in committed) {
                    ownership.transaction = transaction;
                    await disconnect();
                  }
                  return committed;
                };
              } else await disconnect();

              // Omitting the receipt reference must not let the final answer bypass the check.
              const publication =
                type === 'answer'
                  ? session.handleRequest({ ...frame(), type, delta: content })
                  : session.handleRequest({
                      ...frame(),
                      type,
                      usage: { iterations: 1, tokens: null },
                      goal_result: {
                        status: 'completed',
                        outcomes: [
                          { description: 'Read Docx', status: 'achieved', receipt_refs: [] },
                        ],
                        clarification: null,
                        answer: content,
                      },
                    });
              await expect(publication).rejects.toThrow('Feishu observation authorization expired');
              expect(published).toHaveLength(1);
              expect(JSON.stringify(published)).toContain(delivered);
              expect(JSON.stringify(published)).not.toContain(content);
              const eventTypes = (await listRunEvents(db.pool, viewer.ownerId, context.runId)).map(
                ({ type }) => type,
              );
              const expectedTypes: typeof eventTypes = ['message.delta'];
              if (afterCommit)
                expectedTypes.push(type === 'answer' ? 'message.delta' : 'thread.completed');
              expect(eventTypes).toEqual(expectedTypes);
              if (!afterCommit) {
                expect(
                  (await getRunView(deps, viewer.ownerId, context.conversationId, context.runId))
                    .status,
                ).toBe('running');
                const assistant = await db.pool.query(
                  `SELECT 1 FROM messages WHERE conversation_id=$1 AND role='assistant'`,
                  [context.conversationId],
                );
                expect(assistant.rowCount).toBe(0);
                const cancelled = await cancelConversationRun(
                  deps,
                  viewer.ownerId,
                  context.conversationId,
                  context.runId,
                  randomUUID(),
                  { idempotency_key: randomUUID() },
                );
                expect(cancelled.status).toBe('cancelled');
                const history = await listRunEvents(db.pool, viewer.ownerId, context.runId);
                expect(history.map(({ type }) => type)).toEqual([
                  'message.delta',
                  'thread.cancelled',
                ]);
                expect(JSON.stringify(history)).toContain(delivered);
                expect(JSON.stringify(history)).not.toContain(content);
              }
            } finally {
              await session.close();
            }
          } finally {
            await ownership.close();
          }
          await connect();
        }
      }
      beforeRawContent = disconnect;
      const late = await reserveToolInvocation(db.pool, fresh, {
        callKey: 'harness/4',
        toolId,
        args,
      });
      expect(await invokeTool(db.pool, fresh, { ...late, toolId, args })).toMatchObject({
        status: 'denied',
        error: { code: 'TOOL_FORBIDDEN' },
      });
      const lateStored = await db.pool.query(
        'SELECT outcome_kind,accepted_result FROM tool_invocations WHERE invocation_id=$1',
        [late.invocationId],
      );
      expect(lateStored.rows[0]?.outcome_kind).toBe('denied');
      expect(JSON.stringify(lateStored.rows)).not.toContain(content);
      const countAfterDisconnect = calls.length;
      expect(await invokeTool(db.pool, fresh, { ...slot, toolId, args })).toMatchObject({
        status: 'denied',
        error: { code: 'TOOL_FORBIDDEN' },
      });
      expect(calls).toHaveLength(countAfterDisconnect);
    } finally {
      globalThis.fetch = fetchBefore;
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await db.close();
    }
  },
  30_000,
);
