import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { cancelConversationRun } from '../../src/agent/operations/run.js';
import { reserveToolInvocation, invokeTool } from '../../src/agent/tools/gateway.js';
import { readInvocationSnapshots } from '../../src/agent/tools/invocations/invocations.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { loadTimeContext } from '../../src/features/time/public.js';
import { contextOf } from '../../src/agent/runtime/context.js';
import type { RunRow } from '../../src/features/conversations/public.js';
import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import { createIntegrationDatabase, seedAdmittedSession } from './setup.js';

const source =
  'https://learn.microsoft.com/azure/postgresql/backup-restore/concepts-backup-restore';

const exactQuery = '  Azure PostgreSQL Flexible Server backup retention 🧪  ';

test('ordinary Runs search model queries with frozen scopes, immutable audit and cancel acceptance barriers', async () => {
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
    async function admit(session = first, overrides: Record<string, unknown> = {}) {
      const { context } = await startConversationRun(
        deps,
        session.userId,
        randomUUID(),
        {
          execution: 'harness',
          authorization_revision: 'delegation/1',
          raw_text:
            '请查微软官方文档，Azure Database for PostgreSQL Flexible Server 的备份保留多久？请给出处',
          ...overrides,
        },
        null,
        session.sessionId,
      );
      if (!context) throw new Error('no context');
      return context;
    }
    const fresh = await admit();
    expect(fresh.allowlist).toContain('learn_docs_search');
    expect((await admit(second)).allowlist).toContain('learn_docs_search');
    const ordinary = await admit(first, { raw_text: '你好' });
    expect(ordinary.allowlist).toContain('learn_docs_search');
    expect(requests).toEqual([]);
    // A persisted legacy Run has no public-search grant; restoration must not add tools.
    const old = await admit(first, { authorization_revision: undefined });
    const restoreClient = await db.pool.connect();
    try {
      for (const ctx of [old, fresh]) {
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
        expect(restored.allowlist.includes('learn_docs_search')).toBe(ctx === fresh);
      }
    } finally {
      restoreClient.release();
    }
    const toolId = 'learn_docs_search';
    const args = { query: exactQuery };
    const slot = (ctx: typeof fresh, value: unknown = args) =>
      reserveToolInvocation(db.pool, ctx, { callKey: randomUUID(), toolId, args: value });
    await expect(slot(old)).rejects.toThrow();
    await expect(slot({ ...old, allowlist: [...old.allowlist, toolId] })).rejects.toThrow();
    await expect(slot({ ...fresh, ownerId: second.userId })).rejects.toThrow();
    expect(requests).toEqual([]);
    const firstSlot = await slot(fresh);
    const result = await invokeTool(db.pool, fresh, { ...firstSlot, toolId, args });
    expect(result).toMatchObject({
      status: 'ok',
      result: {
        kind: toolId,
        query: exactQuery,
        representation: 'search_excerpts',
        items: [{ url: source }],
      },
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
    const history = await db.pool.connect();
    try {
      expect(await readInvocationSnapshots(history, fresh, [firstSlot.invocationId])).toMatchObject(
        [{ result: { status: 'ok', result: { kind: toolId, items: [{ url: source }] } } }],
      );
    } finally {
      history.release();
    }
    for (const bad of [
      {},
      { query: '' },
      { query: ' \n ' },
      { query: '🧪'.repeat(501) },
      { query: '\ud800' },
      { query: exactQuery, url: 'https://foreign.invalid' },
      { query: exactQuery, tool: 'microsoft_docs_fetch' },
    ]) {
      const ctx = await admit();
      const ref = await slot(ctx, bad);
      expect(await invokeTool(db.pool, ctx, { ...ref, toolId, args: bad })).toMatchObject({
        status: 'denied',
        error: { code: 'TOOL_INPUT_INVALID' },
      });
      expect(requests.length).toBe(count);
    }
    const unknownCtx = await admit();
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
    const canceled = await admit();
    const cancelRef = await slot(canceled);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    hold = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = invokeTool(db.pool, canceled, { ...cancelRef, toolId, args });
    await entered.promise;
    await cancelConversationRun(
      deps,
      canceled.ownerId,
      canceled.conversationId,
      canceled.runId,
      randomUUID(),
      { idempotency_key: randomUUID() },
    );
    release.resolve();
    expect(await pending).toMatchObject({ status: 'denied' });
    expect(
      (
        await db.pool.query('SELECT accepted_result FROM tool_invocations WHERE invocation_id=$1', [
          cancelRef.invocationId,
        ])
      ).rows[0].accepted_result?.status,
    ).not.toBe('ok');
    hold = undefined;
    const afterCancel = requests.length;
    expect(await invokeTool(db.pool, canceled, { ...cancelRef, toolId, args })).toMatchObject({
      status: 'denied',
    });
    expect(requests.length).toBe(afterCancel);
    serviceFails = true;
    const failedRef = await slot(fresh);
    expect(await invokeTool(db.pool, fresh, { ...failedRef, toolId, args })).toMatchObject({
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
