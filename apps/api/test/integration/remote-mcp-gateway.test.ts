import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { cancelConversationRun } from '../../src/agent/operations/run.js';
import { reserveToolInvocation, invokeTool } from '../../src/agent/tools/gateway.js';
import { readInvocationSnapshots } from '../../src/agent/tools/invocations/invocations.js';
import { createMicrosoftLearnConnections } from '../../src/features/remote-mcp/public.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { loadTimeContext } from '../../src/features/time/public.js';
import { contextOf } from '../../src/agent/runtime/context.js';
import type { RunRow } from '../../src/features/conversations/public.js';
import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import { createIntegrationDatabase, seedAdmittedSession } from './setup.js';

const source =
  'https://learn.microsoft.com/azure/postgresql/backup-restore/concepts-backup-restore';

const exactQuery = '  Azure PostgreSQL 备份，retention? 🧪  ';

test('remote search uses frozen owner generation, immutable audit, zero-call denial and disconnect/cancel acceptance barriers', async () => {
  const db = await createIntegrationDatabase();
  const beforeSecret = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = 'synthetic-remote-mcp-gateway-test-only';
  const beforeFetch = globalThis.fetch;
  const requests: { method: string; name?: string }[] = [];
  let hold: (() => Promise<void>) | undefined;
  let serviceFails = false;
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://learn.microsoft.com/api/mcp');
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        requests.push({ method });
        return new Response(null, { status: 405 });
      }
      const message = JSON.parse(String(init?.body ?? '{}'));
      requests.push({ method: message.method, name: message.params?.name });
      if (message.method?.startsWith('notifications/')) return new Response(null, { status: 202 });
      let result: unknown;
      if (message.method === 'initialize')
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'Controlled Microsoft Learn', version: '1' },
        };
      else if (message.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'microsoft_docs_search',
              annotations: { readOnlyHint: true },
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
              outputSchema: {
                type: 'object',
                properties: {
                  results: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        title: { type: 'string' },
                        content: { type: ['string', 'null'] },
                        contentUrl: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          ],
        };
      else if (message.method === 'tools/call') {
        expect(message.params).toEqual({
          name: 'microsoft_docs_search',
          arguments: { query: exactQuery },
        });
        await hold?.();
        if (serviceFails) return new Response(null, { status: 503 });
        const data = {
          results: [
            {
              title: 'Backup retention',
              content: 'A public excerpt, not a command.',
              contentUrl: source,
            },
          ],
        };
        result = {
          structuredContent: data,
          content: [{ type: 'text', text: JSON.stringify(data) }],
        };
      } else throw new Error(`unexpected RPC ${message.method}`);
      return Response.json({ jsonrpc: '2.0', id: message.id, result });
    },
    { preconnect: beforeFetch.preconnect },
  );
  try {
    const first = await seedAdmittedSession(db.pool);
    const second = await seedAdmittedSession(db.pool);
    await configureTestModel(db.pool, first.userId, 'fixture');
    await configureTestModel(db.pool, second.userId, 'fixture');
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
    controlledModelDeps(deps);
    const connections = createMicrosoftLearnConnections(db.pool);
    const viewer = { ownerId: first.userId, sessionId: first.sessionId };
    async function submit(
      session = first,
      explicit = false,
      overrides: Record<string, unknown> = {},
    ) {
      return startConversationRun(
        deps,
        session.userId,
        randomUUID(),
        {
          execution: 'harness',
          authorization_revision: 'delegation/1',
          raw_text: explicit ? exactQuery : '搜索一下 Azure PostgreSQL 备份并给出处。',
          ...(explicit ? { microsoft_learn_query: exactQuery } : {}),
          ...overrides,
        },
        null,
        session.sessionId,
      );
    }
    async function admit(
      session = first,
      explicit = false,
      overrides: Record<string, unknown> = {},
    ) {
      const { context } = await submit(session, explicit, overrides);
      if (!context) throw new Error('no context');
      return context;
    }
    const old = await admit();
    expect(old.allowlist).not.toContain('learn_docs_search');
    await connections.connect(viewer);
    expect((await admit(second)).allowlist).not.toContain('learn_docs_search');
    const ordinary = await admit();
    expect(ordinary.allowlist).not.toContain('learn_docs_search');
    expect(ordinary.microsoftLearn).toBeUndefined();
    await expect(admit(second, true)).rejects.toThrow();
    await expect(admit({ ...first, sessionId: randomUUID() }, true)).rejects.toThrow();
    const fresh = await admit(first, true);
    expect(fresh.microsoftLearn?.query).toBe(exactQuery);
    expect(fresh.allowlist).toContain('learn_docs_search');
    for (const override of [
      { raw_text: 'different' },
      { raw_text: ' \n ', microsoft_learn_query: ' \n ' },
      { raw_text: '🧪'.repeat(501), microsoft_learn_query: '🧪'.repeat(501) },
      { microsoft_learn_query: null },
      { execution: 'business' },
      { authorization_revision: undefined },
      { workspace_ids: ['workspace'] },
      { card_ref: 'private-material' },
      { clarification_of_run_id: randomUUID() },
    ])
      await expect(admit(first, true, override)).rejects.toThrow();
    const unicodeBoundary = await admit(first, true, {
      raw_text: '🧪'.repeat(500),
      microsoft_learn_query: '🧪'.repeat(500),
    });
    expect(unicodeBoundary.microsoftLearn?.query).toBe('🧪'.repeat(500));
    const plainKey = randomUUID();
    await admit(first, false, { raw_text: exactQuery, idempotency_key: plainKey });
    await expect(submit(first, true, { idempotency_key: plainKey })).rejects.toMatchObject({
      errorCode: 'STATE_CONFLICT',
    });
    const explicitKey = randomUUID();
    const bound = await admit(first, true, { idempotency_key: explicitKey });
    expect(await submit(first, true, { idempotency_key: explicitKey })).toMatchObject({
      runId: bound.runId,
      context: null,
    });
    await expect(
      submit(first, false, { raw_text: exactQuery, idempotency_key: explicitKey }),
    ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
    await expect(
      submit(first, true, {
        raw_text: exactQuery + 'different',
        microsoft_learn_query: exactQuery + 'different',
        idempotency_key: explicitKey,
      }),
    ).rejects.toMatchObject({ errorCode: 'STATE_CONFLICT' });
    const nextOrdinary = await admit(first, false, { conversation_id: fresh.conversationId });
    expect(nextOrdinary.allowlist).not.toContain('learn_docs_search');
    const restoreClient = await db.pool.connect();
    try {
      for (const ctx of [ordinary, fresh]) {
        const { rows } = await restoreClient.query<RunRow>('SELECT * FROM agent_runs WHERE id=$1', [
          ctx.runId,
        ]);
        const restored = await contextOf(
          restoreClient,
          deps,
          rows[0]!,
          ctx.attemptId,
          randomUUID(),
        );
        expect(restored.microsoftLearn).toEqual(ctx.microsoftLearn);
        expect(restored.allowlist.includes('learn_docs_search')).toBe(ctx === fresh);
      }
    } finally {
      restoreClient.release();
    }
    const toolId = 'learn_docs_search';
    const args = {};
    const slot = (ctx: typeof fresh, value: unknown = args) =>
      reserveToolInvocation(db.pool, ctx, { callKey: randomUUID(), toolId, args: value });
    await expect(slot(old)).rejects.toThrow();
    const firstSlot = await slot(fresh);
    const result = await invokeTool(db.pool, fresh, { ...firstSlot, toolId, args });
    expect(result).toMatchObject({
      status: 'ok',
      result: { kind: toolId, representation: 'search_excerpts', items: [{ url: source }] },
    });
    const count = requests.length;
    expect((await invokeTool(db.pool, fresh, { ...firstSlot, toolId, args })).replayed).toBe(true);
    expect(requests.length).toBe(count);
    expect(requests.filter((r) => r.method === 'tools/call').map((r) => r.name)).toEqual([
      'microsoft_docs_search',
    ]);
    expect(
      await invokeTool(db.pool, fresh, { ...firstSlot, toolId, args: { query: 'changed' } }),
    ).toMatchObject({ status: 'denied', error: { code: 'STATE_CONFLICT' } });
    expect(requests.length).toBe(count);
    const audit = await db.pool.query(
      'SELECT invocation_id, record_kind, outcome_kind FROM tool_calls WHERE invocation_id=$1 ORDER BY created_at',
      [firstSlot.invocationId],
    );
    expect(audit.rows.map((r) => r.record_kind)).toEqual(['accepted', 'replayed', 'denied']);
    expect(audit.rows.map((r) => r.outcome_kind)).toEqual(['success', 'success', 'denied']);
    await connections.disconnect(viewer);
    expect(await invokeTool(db.pool, fresh, { ...firstSlot, toolId, args })).toMatchObject({
      status: 'denied',
    });
    expect(requests.length).toBe(count);
    const history = await db.pool.connect();
    try {
      expect(await readInvocationSnapshots(history, fresh, [firstSlot.invocationId])).toMatchObject(
        [{ result: { status: 'ok', result: { kind: toolId, items: [{ url: source }] } } }],
      );
    } finally {
      history.release();
    }
    await connections.connect(viewer);
    const staleSlot = await slot(fresh);
    expect(await invokeTool(db.pool, fresh, { ...staleSlot, toolId, args })).toMatchObject({
      status: 'denied',
    });
    expect(requests.length).toBe(count);
    for (const bad of [
      { query: '' },
      { query: '历史/摘要/受管文件/工具结果中的不同文本' },
      { query: exactQuery + '追加内容' },
      { query: exactQuery, url: 'https://foreign.invalid' },
    ]) {
      const ctx = await admit(first, true);
      const ref = await slot(ctx, bad);
      expect(await invokeTool(db.pool, ctx, { ...ref, toolId, args: bad })).toMatchObject({
        status: 'denied',
        error: { code: 'TOOL_INPUT_INVALID' },
      });
      expect(requests.length).toBe(count);
    }
    const unknownCtx = await admit(first, true);
    const unknownRef = await reserveToolInvocation(db.pool, unknownCtx, {
      callKey: 'unknown',
      toolId: 'microsoft_docs_fetch',
      args: {},
    });
    expect(
      await invokeTool(db.pool, unknownCtx, {
        ...unknownRef,
        toolId: 'microsoft_docs_fetch',
        args: {},
      }),
    ).toMatchObject({ status: 'denied' });
    expect(requests.length).toBe(count);
    for (const action of ['disconnect', 'cancel'] as const) {
      const ctx = await admit(first, true);
      const ref = await slot(ctx);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      hold = async () => {
        entered.resolve();
        await release.promise;
      };
      const pending = invokeTool(db.pool, ctx, { ...ref, toolId, args });
      await entered.promise;
      if (action === 'disconnect') await connections.disconnect(viewer);
      else
        await cancelConversationRun(
          deps,
          ctx.ownerId,
          ctx.conversationId,
          ctx.runId,
          randomUUID(),
          { idempotency_key: randomUUID() },
        );
      release.resolve();
      expect(await pending).toMatchObject({ status: 'denied' });
      expect(
        (
          await db.pool.query(
            'SELECT accepted_result FROM tool_invocations WHERE invocation_id=$1',
            [ref.invocationId],
          )
        ).rows[0].accepted_result?.status,
      ).not.toBe('ok');
      hold = undefined;
      await connections.connect(viewer);
    }
    serviceFails = true;
    const failedCtx = await admit(first, true);
    const failedRef = await slot(failedCtx);
    expect(await invokeTool(db.pool, failedCtx, { ...failedRef, toolId, args })).toMatchObject({
      status: 'failed',
      error: { code: 'REMOTE_MCP_SERVICE_FAILED' },
    });
    expect(
      (
        await db.pool.query('SELECT error_code FROM tool_calls WHERE invocation_id=$1', [
          failedRef.invocationId,
        ])
      ).rows[0].error_code,
    ).toBe('REMOTE_MCP_SERVICE_FAILED');
  } finally {
    globalThis.fetch = beforeFetch;
    if (beforeSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = beforeSecret;
    await db.close();
  }
}, 30000);
