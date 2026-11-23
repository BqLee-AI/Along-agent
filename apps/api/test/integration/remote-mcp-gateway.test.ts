import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { cancelConversationRun } from '../../src/agent/operations/run.js';
import { reserveToolInvocation, invokeTool } from '../../src/agent/tools/gateway.js';
import { readInvocationSnapshots } from '../../src/agent/tools/invocations/invocations.js';
import { createMicrosoftLearnConnections } from '../../src/features/remote-mcp/public.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { loadTimeContext } from '../../src/features/time/public.js';
import { configureTestModel } from '../helpers/model-selection.js';
import { createIntegrationDatabase, seedAdmittedSession } from './setup.js';

const source =
  'https://learn.microsoft.com/azure/postgresql/backup-restore/concepts-backup-restore';

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
          arguments: { query: 'Azure PostgreSQL backup retention' },
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
    const connections = createMicrosoftLearnConnections(db.pool);
    const viewer = { ownerId: first.userId, sessionId: first.sessionId };
    async function admit(session = first) {
      const { context } = await startConversationRun(
        deps,
        session.userId,
        randomUUID(),
        {
          execution: 'harness',
          authorization_revision: 'delegation/1',
          raw_text: '查询 Azure PostgreSQL 备份保留策略并给出处。',
        },
        null,
        session.sessionId,
      );
      if (!context) throw new Error('no context');
      return context;
    }
    const old = await admit();
    expect(old.allowlist).not.toContain('learn_docs_search');
    await connections.connect(viewer);
    expect((await admit(second)).allowlist).not.toContain('learn_docs_search');
    const fresh = await admit();
    expect(fresh.allowlist).toContain('learn_docs_search');
    const toolId = 'learn_docs_search';
    const args = { query: 'Azure PostgreSQL backup retention' };
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
    for (const bad of [{ query: '' }, { query: 'x', url: 'https://foreign.invalid' }]) {
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
    for (const action of ['disconnect', 'cancel'] as const) {
      const ctx = await admit();
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
    const failedCtx = await admit();
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
