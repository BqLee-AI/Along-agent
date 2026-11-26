import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureWorkspaceRegistry,
  getWorkspaceGrant,
} from '../../src/features/workspaces/public.js';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import {
  executeNonTransactionalInvocation,
  executeReadOnlyInvocation,
  reserveInvocation,
  ToolExecutionError,
} from '../../src/agent/tools/invocations/invocations.js';
import {
  readRunContextObservations,
  readRunContextSource,
} from '../../src/agent/tools/invocations/context-query.js';
import { readRunDocumentEvidence } from '../../src/agent/tools/evidence/run-evidence.js';
import type {
  InvocationInput,
  ToolContext,
  ToolOutcome,
  ToolPayload,
} from '../../src/agent/tools/contracts.js';
import { seedContext } from './tool-invocations-probe.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const version = 'a'.repeat(64);
function payload(outcome: ToolOutcome) {
  if (outcome.status !== 'ok') throw new Error(`Expected accepted data: ${outcome.status}`);
  return outcome.result;
}

maybe('immutable accepted context sources', () => {
  let database: IntegrationDatabase;
  const roots: string[] = [];
  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await configureWorkspaceRegistry([]);
    await database?.close();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fresh() {
    const ownerId = randomUUID();
    const root = await mkdtemp(join(tmpdir(), 'along-context-source-'));
    roots.push(root);
    await configureWorkspaceRegistry([
      {
        workspace_id: 'context-source',
        owner_id: ownerId,
        label: 'Context source',
        root,
        readable_paths: ['memo.txt'],
        writable_paths: ['memo.txt'],
      },
    ]);
    const ctx: ToolContext = {
      ...(await seedContext(database.pool, {
        ownerId,
        workspaceGrant: getWorkspaceGrant(ownerId, 'context-source'),
      })),
      allowlist: ['workspace_read', 'workspace_grep', 'workspace_list', 'read_run_observation'],
    };
    async function accept(toolId: string, result: ToolPayload) {
      const args = { path: 'memo.txt' };
      const input = {
        ...(await reserveToolInvocation(database.pool, ctx, {
          callKey: randomUUID(),
          toolId,
          args,
        })),
        toolId,
        args,
      };
      return executeReadOnlyInvocation(database.pool, ctx, input, async () => ({
        status: 'ok',
        result,
      }));
    }
    async function page(source: string, field = 'content', offset = 0, limit = 100000) {
      const toolId = 'read_run_observation';
      const args = { source_invocation_id: source, field, offset, limit };
      const input = {
        ...(await reserveToolInvocation(database.pool, ctx, {
          callKey: randomUUID(),
          toolId,
          args,
        })),
        toolId,
        args,
      };
      return { input, outcome: await invokeTool(database.pool, ctx, input) };
    }
    return { ctx, accept, page };
  }

  it('pages exact accepted Unicode, BOM and CRLF in bounded JSON and replays the same immutable page', async () => {
    const f = await fresh();
    const text = '\uFEFF😀\r\n"\\中文'.repeat(3000);
    const source = await f.accept('workspace_read', {
      kind: 'read',
      path: 'memo.txt',
      version,
      byte_length: Buffer.byteLength(text),
      content: text,
    });
    const before = (
      await database.pool.query(
        'SELECT accepted_result FROM tool_invocations WHERE invocation_id=$1',
        [source.invocationId],
      )
    ).rows[0];
    let offset = 0;
    let reconstructed = '';
    let first: { input: InvocationInput; outcome: ToolOutcome } | undefined;
    for (;;) {
      const current = await f.page(source.invocationId, 'content', offset);
      first ??= current;
      const value = payload(current.outcome);
      expect(value.kind).toBe('context_slice');
      if (value.kind !== 'context_slice' || !('content' in value))
        throw new Error('Expected content slice');
      expect(
        Buffer.byteLength(JSON.stringify({ status: 'ok', result: value })),
      ).toBeLessThanOrEqual(16384);
      expect(value).toMatchObject({
        source_result_version: 1,
        version,
        unit: 'unicode_scalar',
        offset,
        total: Array.from(text).length,
      });
      expect(value.end).toBeGreaterThan(offset);
      reconstructed += value.content;
      offset = value.end;
      if (!value.has_more) break;
    }
    expect(reconstructed).toBe(text);
    expect(await invokeTool(database.pool, f.ctx, first!.input)).toEqual({
      ...first!.outcome,
      replayed: true,
    });
    expect(
      (
        await database.pool.query(
          'SELECT accepted_result FROM tool_invocations WHERE invocation_id=$1',
          [source.invocationId],
        )
      ).rows[0],
    ).toEqual(before);
    expect(
      (
        await database.pool.query(
          'SELECT execution_kind FROM tool_invocations WHERE invocation_id=$1',
          [first!.input.invocationId],
        )
      ).rows[0],
    ).toEqual({ execution_kind: 'read_only' });
    expect(
      payload((await f.page(source.invocationId, 'content', offset + 10, 1)).outcome),
    ).toMatchObject({
      kind: 'context_slice',
      offset: offset + 10,
      end: offset + 10,
      content: '',
      has_more: false,
    });
    const client = await database.pool.connect();
    try {
      const evidence = await readRunDocumentEvidence(client, f.ctx);
      expect(evidence.reads.map((read) => read.invocation_id)).toEqual([source.invocationId]);
      expect(evidence.reads[0]?.result.content).toBe(text);
    } finally {
      client.release();
    }
  });

  it('retains stable search elements and failures; oversized elements fail explicitly and slices cannot recurse', async () => {
    const f = await fresh();
    const matches = [
      { path: 'memo.txt', line: 2, text: 'old date', version },
      { path: 'memo.txt', line: 3, text: 'new date', version: 'b'.repeat(64) },
      { path: 'memo.txt', line: 4, text: '"\\😀'.repeat(6000), version },
    ];
    const failures = [
      { kind: 'operation_error' as const, path: 'missing.txt', reason: 'not_found' as const },
    ];
    const source = await f.accept('workspace_grep', {
      kind: 'search',
      path: '',
      matches,
      failures,
    });
    const first = (await f.page(source.invocationId, 'matches', 0, 3)).outcome;
    expect(payload(first)).toMatchObject({
      kind: 'context_slice',
      items: matches.slice(0, 2),
      end: 2,
      total: 3,
      has_more: true,
      unit: 'items',
    });
    expect(payload((await f.page(source.invocationId, 'matches', 2, 1)).outcome)).toEqual({
      kind: 'operation_error',
      path: '',
      reason: 'range_too_large',
    });
    expect(payload((await f.page(source.invocationId, 'failures')).outcome)).toMatchObject({
      items: failures,
      total: 1,
    });
    expect(payload((await f.page(first.invocationId, 'matches')).outcome)).toEqual({
      kind: 'operation_error',
      path: '',
      reason: 'unsupported_source',
    });
    expect(payload((await f.page(source.invocationId, 'content')).outcome)).toEqual({
      kind: 'operation_error',
      path: '',
      reason: 'unsupported_source',
    });
    const entries = [
      { path: 'z.txt', kind: 'file' as const },
      { path: 'a', kind: 'directory' as const },
    ];
    const listed = await f.accept('workspace_list', { kind: 'list', path: '', entries, failures });
    expect(payload((await f.page(listed.invocationId, 'entries', 1, 1)).outcome)).toMatchObject({
      items: [entries[1]],
      offset: 1,
      end: 2,
      total: 2,
      has_more: false,
    });
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE', [f.ctx.runId]);
      expect(
        await readRunContextObservations(client, f.ctx, [source.invocationId], { project: true }),
      ).toEqual([
        {
          view: 'projected',
          invocation_id: source.invocationId,
          tool_id: 'workspace_grep',
          outcome: 'ok',
          source: {
            kind: 'search',
            result_version: 1,
            omitted: true,
            path: '',
            matches_total: 3,
            failures_total: 1,
          },
        },
      ]);
      expect(await readRunContextSource(client, f.ctx, source.invocationId, 'full')).toMatchObject({
        view: 'full',
        result: { status: 'ok', result: { matches, failures } },
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects unknown, foreign-Run and revoked sources without returning old data', async () => {
    const f = await fresh();
    const source = await f.accept('workspace_read', {
      kind: 'read',
      path: 'memo.txt',
      version,
      byte_length: 6,
      content: 'secret',
    });
    const first = await f.page(source.invocationId);
    f.ctx.allowlist = ['read_run_observation'];
    expect(await invokeTool(database.pool, f.ctx, first.input)).toMatchObject({
      status: 'denied',
      error: { code: 'TOOL_FORBIDDEN' },
    });
    expect((await f.page(source.invocationId)).outcome.status).toBe('denied');
    f.ctx.allowlist = ['workspace_read', 'read_run_observation'];
    expect((await f.page(randomUUID())).outcome.status).toBe('denied');
    const reserved = await reserveToolInvocation(database.pool, f.ctx, {
      callKey: 'unfinished',
      toolId: 'workspace_read',
      args: { path: 'memo.txt' },
    });
    expect((await f.page(reserved.invocationId)).outcome.status).toBe('denied');
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await invokeTool(database.pool, { ...f.ctx, signal: aborted.signal }, first.input),
    ).toMatchObject({ status: 'denied' });
    for (const scope of [
      { ownerId: randomUUID() },
      { conversationId: randomUUID() },
      { runId: randomUUID() },
    ])
      expect(await invokeTool(database.pool, { ...f.ctx, ...scope }, first.input)).toMatchObject({
        status: 'denied',
      });
    const other = await seedContext(database.pool);
    const args = {
      source_invocation_id: source.invocationId,
      field: 'content',
      offset: 0,
      limit: 1,
    };
    const foreignCtx = { ...other, allowlist: ['read_run_observation', 'workspace_read'] };
    const foreign = {
      ...(await reserveToolInvocation(database.pool, foreignCtx, {
        callKey: 'foreign',
        toolId: 'read_run_observation',
        args,
      })),
      toolId: 'read_run_observation',
      args,
    };
    expect(await invokeTool(database.pool, foreignCtx, foreign)).toMatchObject({
      status: 'denied',
    });
    await configureWorkspaceRegistry([]);
    expect(await invokeTool(database.pool, f.ctx, first.input)).toMatchObject({ status: 'denied' });
  });

  it('fences completed page replay after cancellation or attempt replacement', async () => {
    const f = await fresh();
    const source = await f.accept('workspace_read', {
      kind: 'read',
      path: 'memo.txt',
      version,
      byte_length: 6,
      content: 'secret',
    });
    const first = await f.page(source.invocationId);
    await database.pool.query(
      'INSERT INTO run_attempts(id,owner_id,run_id,attempt_no) VALUES($1,$2,$3,2)',
      [randomUUID(), f.ctx.ownerId, f.ctx.runId],
    );
    expect(await invokeTool(database.pool, f.ctx, first.input)).toMatchObject({ status: 'denied' });
    await database.pool.query(
      "UPDATE agent_runs SET status='cancelled',ended_at=clock_timestamp() WHERE id=$1",
      [f.ctx.runId],
    );
    expect(await invokeTool(database.pool, f.ctx, first.input)).toMatchObject({ status: 'denied' });
  });

  it('does not project the only body of an old allowlist and keeps accepted errors and approval receipts full', async () => {
    const f = await fresh();
    const read = await f.accept('workspace_read', {
      kind: 'read',
      path: 'memo.txt',
      version,
      byte_length: 3,
      content: 'old',
    });
    const missing = await f.accept('workspace_read', {
      kind: 'operation_error',
      path: 'memo.txt',
      reason: 'not_found',
    });
    f.ctx.allowlist = ['workspace_read', 'propose_task'];
    const args = { raw_time_text: '2026-11-02 09:20', note: '喝水', occurrence: 'once' };
    const toolId = 'propose_task';
    const input = {
      ...(await reserveToolInvocation(database.pool, f.ctx, { callKey: 'approval', toolId, args })),
      toolId,
      args,
    };
    const proposal = await invokeTool(database.pool, f.ctx, input);
    expect(payload(proposal).kind).toBe('approval');
    const client = await database.pool.connect();
    try {
      const views = await readRunContextObservations(
        client,
        f.ctx,
        [read.invocationId, missing.invocationId, proposal.invocationId],
        { project: true },
      );
      expect(views.map((view) => view.view)).toEqual(['full', 'full', 'full']);
      expect(views[0]).toMatchObject({
        result: { status: 'ok', result: { kind: 'read', content: 'old' } },
      });
      expect(views[1]).toMatchObject({
        result: { status: 'ok', result: { kind: 'operation_error', reason: 'not_found' } },
      });
      expect(views[2]).toMatchObject({ result: { status: 'ok', result: { kind: 'approval' } } });
      const deniedArgs = {
        source_invocation_id: read.invocationId,
        field: 'content',
        offset: 0,
        limit: 1,
      };
      const deniedInput = {
        ...(await reserveToolInvocation(database.pool, f.ctx, {
          callKey: 'old-denied',
          toolId: 'read_run_observation',
          args: deniedArgs,
        })),
        toolId: 'read_run_observation',
        args: deniedArgs,
      };
      expect(await invokeTool(database.pool, f.ctx, deniedInput)).toMatchObject({
        status: 'denied',
        error: { code: 'TOOL_DENIED' },
      });
    } finally {
      client.release();
    }
  });

  it('rejects injected and unsafe paging arguments without disclosing source bytes', async () => {
    const f = await fresh();
    const source = await f.accept('workspace_read', {
      kind: 'read',
      path: 'memo.txt',
      version,
      byte_length: 6,
      content: 'secret',
    });
    for (const extra of [
      { owner_id: f.ctx.ownerId },
      { offset: -1 },
      { offset: Number.MAX_SAFE_INTEGER + 1 },
      { limit: 0 },
    ]) {
      const args = {
        source_invocation_id: source.invocationId,
        field: 'content',
        offset: 0,
        limit: 1,
        ...extra,
      };
      const input = {
        ...(await reserveToolInvocation(database.pool, f.ctx, {
          callKey: randomUUID(),
          toolId: 'read_run_observation',
          args,
        })),
        toolId: 'read_run_observation',
        args,
      };
      const denied = await invokeTool(database.pool, f.ctx, input);
      expect(denied).toMatchObject({ status: 'denied', error: { code: 'TOOL_FORBIDDEN' } });
      expect(JSON.stringify(denied)).not.toContain('secret');
    }
  });

  it('keeps zero-write conflict identities and accepted failed/denied outcomes intact', async () => {
    const f = await fresh();
    const toolId = 'internal.context-conflict';
    f.ctx.allowlist = [...f.ctx.allowlist, toolId];
    await database.pool.query(
      `UPDATE personal_bots b SET config=jsonb_set(b.config,'{tool_ids}',(b.config->'tool_ids') || to_jsonb($2::text))
       FROM conversations c WHERE c.id=$1 AND b.id=c.bot_id`,
      [f.ctx.conversationId, toolId],
    );
    const args = {};
    const conflictInput = {
      ...(await reserveInvocation(database.pool, f.ctx, {
        callKey: 'conflict',
        toolId,
        args,
        executionKind: 'non_transactional',
      })),
      toolId,
      args,
    };
    const conflict = await executeNonTransactionalInvocation(database.pool, f.ctx, conflictInput, {
      execute: async (binding) => ({
        ...binding,
        evidenceRef: 'fixture-conflict',
        result: {
          status: 'ok',
          result: {
            kind: 'conflict',
            workspace_id: 'context-source',
            path: 'memo.txt',
            approval_id: randomUUID(),
            invocation_id: binding.invocationId,
            args_hash: binding.argsHash,
            base_version: version,
            actual_version: 'b'.repeat(64),
            reason: 'version_changed',
            zero_write: true,
          },
        },
      }),
    });
    const failedInput = {
      ...(await reserveToolInvocation(database.pool, f.ctx, {
        callKey: 'failed',
        toolId: 'workspace_read',
        args,
      })),
      toolId: 'workspace_read',
      args,
    };
    await executeReadOnlyInvocation(database.pool, f.ctx, failedInput, async () => {
      throw new ToolExecutionError();
    });
    const deniedInput = {
      ...(await reserveToolInvocation(database.pool, f.ctx, {
        callKey: 'denied',
        toolId: 'workspace_read',
        args,
      })),
      toolId: 'workspace_read',
      args,
    };
    await invokeTool(database.pool, { ...f.ctx, allowlist: [] }, deniedInput);
    const client = await database.pool.connect();
    try {
      const views = await readRunContextObservations(
        client,
        f.ctx,
        [conflict.invocationId, failedInput.invocationId, deniedInput.invocationId],
        { project: true },
      );
      expect(views.map((view) => view.view)).toEqual(['full', 'full', 'full']);
      expect(views[0]).toMatchObject({ result: { status: 'ok', result: payload(conflict) } });
      expect(views[1]).toMatchObject({
        result: { status: 'failed', error: { code: 'TOOL_ERROR' } },
      });
      expect(views[2]).toMatchObject({
        result: { status: 'denied', error: { code: 'TOOL_DENIED' } },
      });
    } finally {
      client.release();
    }
  });
});
