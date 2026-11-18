import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocumentApprovalReceipt } from '@along/contracts';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { withTransaction } from '../../src/db/transaction.js';
import {
  validateDocumentApprovalsDone,
  validateDocumentApprovalApply,
} from '../../src/features/approvals/document/document-service.js';
import { applyWorkspaceReplace } from '../../src/features/workspaces/write/replace.js';
import {
  configureWorkspaceRegistry,
  getWorkspaceGrant,
} from '../../src/features/workspaces/public.js';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import {
  executeReadOnlyInvocation,
  executeNonTransactionalInvocation,
} from '../../src/agent/tools/invocations/invocations.js';
import { readRunInvocationStates } from '../../src/agent/tools/invocations/run-state.js';
import { callWorkspaceMcp } from '../../src/agent/tools/workspace/mcp-workspace.js';
import { readRunDocumentEvidence } from '../../src/agent/tools/query.js';
import {
  WORKSPACE_TOOL_IDS,
  type ToolContext,
  type ToolOutcome,
} from '../../src/agent/tools/contracts.js';
import { seedContext } from './tool-invocations-probe.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl && process.platform === 'linux' ? describe : describe.skip;
const initial = '\uFEFFfirst\r\nold 中文\r\nlast  \r\n';
function receiptOf(value: ToolOutcome): DocumentApprovalReceipt {
  if (value.status !== 'ok' || value.result.kind !== 'document_approval')
    throw new Error('expected document proposal');
  return value.result.approval;
}

maybe('real SDK workspace gateway and document invocation ledger', () => {
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
    const root = await mkdtemp(join(tmpdir(), 'along-workspace-gateway-'));
    roots.push(root);
    await writeFile(join(root, 'memo.txt'), initial, { mode: 0o600 });
    await configureWorkspaceRegistry([
      {
        workspace_id: 'gateway-test',
        owner_id: ownerId,
        label: 'Gateway test',
        root,
        readable_paths: ['memo.txt', 'missing.txt'],
        writable_paths: ['memo.txt'],
      },
    ]);
    const ctx: ToolContext = {
      ...(await seedContext(database.pool, {
        ownerId,
        workspaceGrant: getWorkspaceGrant(ownerId, 'gateway-test'),
      })),
      allowlist: WORKSPACE_TOOL_IDS,
    };
    let slot = 0;
    async function reserve(toolId: string, args: unknown) {
      const reserved = await reserveToolInvocation(database.pool, ctx, {
        callKey: `workspace/${++slot}`,
        toolId,
        args,
      });
      return { ...reserved, toolId, args };
    }
    async function call(toolId: string, args: unknown) {
      return invokeTool(database.pool, ctx, await reserve(toolId, args));
    }
    async function propose(oldText = 'old', newText = 'new') {
      const read = await call('workspace_read', { path: 'memo.txt' });
      expect(read).toMatchObject({ status: 'ok', result: { kind: 'read' } });
      const proposal = await call('workspace_propose_replace', {
        read_invocation_id: read.invocationId,
        old_text: oldText,
        new_text: newText,
      });
      return receiptOf(proposal);
    }
    // This suite owns the tool coordinator, not button authentication. The
    // integrated product consumer exercises real confirm; here approved is an
    // explicit DB fixture so failures isolate binding/dispatch/result behavior.
    async function approve(receipt: DocumentApprovalReceipt) {
      await database.pool.query("UPDATE document_approvals SET state='approved' WHERE id=$1", [
        receipt.approval_id,
      ]);
    }
    async function done() {
      await withTransaction(database.pool, async (client) => {
        const evidence = await readRunDocumentEvidence(client, ctx);
        await validateDocumentApprovalsDone(client, ctx, evidence);
      });
    }
    return { ctx, root, reserve, call, propose, approve, done };
  }

  it('actual list/search/read observe files, missing is recoverable, completed reads replay immutable bytes', async () => {
    const f = await fresh();
    expect(await f.call('workspace_list', { path: '' })).toMatchObject({
      status: 'ok',
      result: {
        kind: 'list',
        entries: [{ path: 'memo.txt', kind: 'file' }],
        failures: [{ path: 'missing.txt', reason: 'not_found' }],
      },
    });
    expect(await f.call('workspace_grep', { path: '', literal: '中文' })).toMatchObject({
      status: 'ok',
      result: { kind: 'search', matches: [{ path: 'memo.txt', line: 2, text: 'old 中文' }] },
    });
    expect(await f.call('workspace_read', { path: 'missing.txt' })).toMatchObject({
      status: 'ok',
      result: { kind: 'operation_error', reason: 'not_found' },
    });
    const input = await f.reserve('workspace_read', { path: 'memo.txt' });
    const first = await invokeTool(database.pool, f.ctx, input);
    await writeFile(join(f.root, 'memo.txt'), 'changed source');
    expect(await invokeTool(database.pool, f.ctx, input)).toEqual({ ...first, replayed: true });
    expect(await f.call('workspace_read', { path: 'memo.txt' })).toMatchObject({
      status: 'ok',
      result: { kind: 'read', content: 'changed source' },
    });
  });

  it('two real MCP observations accept one first snapshot; completed replay performs zero MCP', async () => {
    const f = await fresh();
    const input = await f.reserve('workspace_read', { path: 'memo.txt' });
    const observed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const slow = executeReadOnlyInvocation(database.pool, f.ctx, input, async (ctx) => {
      const result = await callWorkspaceMcp(ctx, 'workspace_read', { path: 'memo.txt' });
      observed.resolve();
      await release.promise;
      return { status: 'ok', result };
    });
    await observed.promise;
    try {
      await writeFile(join(f.root, 'memo.txt'), 'winning source');
      const winner = await invokeTool(database.pool, f.ctx, input);
      expect(winner).toMatchObject({
        status: 'ok',
        result: { kind: 'read', content: 'winning source' },
      });
      release.resolve();
      expect(await slow).toEqual({ ...winner, replayed: true });
      expect(
        await executeReadOnlyInvocation(database.pool, f.ctx, input, async () => {
          throw new Error('MCP must not run on replay');
        }),
      ).toEqual({ ...winner, replayed: true });
    } finally {
      release.resolve();
      await slow;
    }
  });

  it('cancellation commits while an actual SDK tool request is waiting and accepts no late file data', async () => {
    const f = await fresh();
    const controller = new AbortController();
    const ctx = { ...f.ctx, signal: controller.signal };
    const input = await f.reserve('workspace_read', { path: 'memo.txt' });
    const waiting = Promise.withResolvers<void>();
    const send = StdioClientTransport.prototype.send;
    let serverPid: number | null = null;
    const intercepted = spyOn(StdioClientTransport.prototype, 'send').mockImplementation(
      async function (this: StdioClientTransport, message) {
        if ('method' in message && message.method === 'tools/call') {
          serverPid = this.pid;
          if (serverPid === null) throw new Error('MCP child must exist before tools/call');
          process.kill(serverPid, 'SIGSTOP');
          await send.call(this, message);
          waiting.resolve();
          return;
        }
        await send.call(this, message);
      },
    );
    const pending = invokeTool(database.pool, ctx, input);
    const client = await database.pool.connect();
    const releaseChild = () => {
      if (serverPid === null) return;
      try {
        process.kill(serverPid, 'SIGCONT');
      } catch {
        // The abort path may already have reaped this test-owned child.
      }
      serverPid = null;
    };
    try {
      await Promise.race([
        waiting.promise,
        pending.then(() => {
          throw new Error('workspace read ended before the actual MCP request could wait');
        }),
      ]);
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='1000ms'");
      await client.query(
        "UPDATE run_attempts SET status='fenced_out',ended_at=clock_timestamp() WHERE id=$1",
        [ctx.attemptId],
      );
      await client.query(
        "UPDATE agent_runs SET status='cancelled',ended_at=clock_timestamp() WHERE id=$1",
        [ctx.runId],
      );
      await client.query('COMMIT');
      expect(
        (await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [ctx.runId]))
          .rows[0]?.status,
      ).toBe('cancelled');
      controller.abort();
      releaseChild();
      const outcome = await pending;
      expect(outcome.status).toBe('denied');
      expect('result' in outcome).toBe(false);
      expect(
        (
          await database.pool.query(
            'SELECT state,accepted_result FROM tool_invocations WHERE invocation_id=$1',
            [input.invocationId],
          )
        ).rows[0],
      ).toEqual({ state: 'reserved', accepted_result: null });
      expect(await readFile(join(f.root, 'memo.txt'), 'utf8')).toBe(initial);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      controller.abort();
      releaseChild();
      await pending.catch(() => undefined);
      intercepted.mockRestore();
    }
  });

  it('strict scope denies traversal and extra fields; proposal literal failures remain accepted observations', async () => {
    const f = await fresh();
    expect(await f.call('workspace_read', { path: '../outside.txt' })).toMatchObject({
      status: 'denied',
    });
    expect(await f.call('workspace_read', { path: 'memo.txt', root: f.root })).toMatchObject({
      status: 'denied',
    });
    const read = await f.call('workspace_read', { path: 'memo.txt' });
    expect(
      await f.call('workspace_propose_replace', {
        read_invocation_id: read.invocationId,
        old_text: 'absent',
        new_text: 'new',
      }),
    ).toMatchObject({
      status: 'ok',
      result: { kind: 'operation_error', reason: 'literal_not_found' },
    });
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int n FROM document_approvals WHERE owner_id=$1',
          [f.ctx.ownerId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(await readFile(join(f.root, 'memo.txt'), 'utf8')).toBe(initial);
  });

  it('approved is not done; apply binds uniquely, preserves exact bytes, requires independent new read', async () => {
    const f = await fresh();
    const receipt = await f.propose();
    await f.approve(receipt);
    await expect(f.done()).rejects.toThrow();
    const input = await f.reserve('workspace_apply_replace', { approval_id: receipt.approval_id });
    await expect(
      f.reserve('workspace_apply_replace', { approval_id: receipt.approval_id }),
    ).rejects.toThrow();
    const applied = await invokeTool(database.pool, f.ctx, input);
    expect(applied).toMatchObject({
      status: 'ok',
      result: {
        kind: 'applied',
        approval_id: receipt.approval_id,
        invocation_id: input.invocationId,
        version: receipt.new_version,
      },
    });
    expect(await readFile(join(f.root, 'memo.txt'), 'utf8')).toBe(initial.replace('old', 'new'));
    expect(await invokeTool(database.pool, f.ctx, input)).toEqual({ ...applied, replayed: true });
    await expect(f.done()).rejects.toThrow();
    await f.call('workspace_read', { path: 'memo.txt' });
    await f.done();
    const state = await withTransaction(database.pool, (client) =>
      readRunInvocationStates(client, f.ctx),
    );
    expect(state.find((row) => row.tool_id === 'workspace_propose_replace')?.approval_ref).toEqual({
      kind: 'document',
      approval_id: receipt.approval_id,
    });
    expect(
      (
        await database.pool.query('SELECT approval_id FROM tool_calls WHERE owner_id=$1', [
          f.ctx.ownerId,
        ])
      ).rows.every((row) => row.approval_id === null),
    ).toBe(true);
  });

  it('zero-write conflict requires a fresh read and uniquely approved applied/read successor before done', async () => {
    const f = await fresh();
    const a = await f.propose();
    await f.approve(a);
    await writeFile(join(f.root, 'memo.txt'), initial + 'external\r\n');
    const conflict = await f.call('workspace_apply_replace', { approval_id: a.approval_id });
    expect(conflict).toMatchObject({
      status: 'ok',
      result: { kind: 'conflict', zero_write: true },
    });
    const b = await f.propose();
    expect(b.replaces_approval_id).toBe(a.approval_id);
    await expect(f.done()).rejects.toThrow();
    await f.approve(b);
    await expect(f.done()).rejects.toThrow();
    expect(await f.call('workspace_apply_replace', { approval_id: b.approval_id })).toMatchObject({
      status: 'ok',
      result: { kind: 'applied' },
    });
    await expect(f.done()).rejects.toThrow();
    await f.call('workspace_read', { path: 'memo.txt' });
    await f.done();
    expect(await readFile(join(f.root, 'memo.txt'), 'utf8')).toBe(
      (initial + 'external\r\n').replace('old', 'new'),
    );
  });

  it('real replacement with failed acceptance stays unknown; original and alternate slots never perform another rename', async () => {
    const f = await fresh();
    const receipt = await f.propose();
    await f.approve(receipt);
    const input = await f.reserve('workspace_apply_replace', { approval_id: receipt.approval_id });
    const trigger = `fail_workspace_accept_${randomUUID().replaceAll('-', '')}`;
    await database.pool
      .query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture acceptance failure'; END $$;
      CREATE TRIGGER ${trigger} BEFORE UPDATE ON tool_invocations FOR EACH ROW
      WHEN (NEW.invocation_id='${input.invocationId}'::uuid AND NEW.state='completed') EXECUTE FUNCTION ${trigger}()`);
    try {
      expect(await invokeTool(database.pool, f.ctx, input)).toMatchObject({
        status: 'unknown',
        error: { code: 'TOOL_EFFECT_UNKNOWN' },
      });
    } finally {
      await database.pool.query(
        `DROP TRIGGER ${trigger} ON tool_invocations; DROP FUNCTION ${trigger}()`,
      );
    }
    expect(await readFile(join(f.root, 'memo.txt'), 'utf8')).toBe(receipt.exact_new_content);
    const inode = (await stat(join(f.root, 'memo.txt'))).ino;
    expect(await invokeTool(database.pool, f.ctx, input)).toMatchObject({ status: 'unknown' });
    await expect(
      f.reserve('workspace_apply_replace', { approval_id: receipt.approval_id }),
    ).rejects.toThrow();
    await f.call('workspace_read', { path: 'memo.txt' });
    await expect(f.done()).rejects.toThrow();
    await expect(f.propose('new', 'again')).rejects.toThrow();
    expect((await stat(join(f.root, 'memo.txt'))).ino).toBe(inode);
    expect(
      (
        await database.pool.query(
          'SELECT state,accepted_result FROM tool_invocations WHERE invocation_id=$1',
          [input.invocationId],
        )
      ).rows[0],
    ).toEqual({ state: 'unknown', accepted_result: null });
  });

  it('real MCP data waits outside locks; cancellation commits first and no late content is accepted', async () => {
    const f = await fresh();
    const input = await f.reserve('workspace_read', { path: 'memo.txt' });
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = executeReadOnlyInvocation(database.pool, f.ctx, input, async (ctx) => {
      const result = await callWorkspaceMcp(ctx, 'workspace_read', { path: 'memo.txt' });
      arrived.resolve();
      await release.promise;
      return { status: 'ok', result };
    });
    await arrived.promise;
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='1000ms'");
      await client.query("UPDATE run_attempts SET status='fenced_out' WHERE id=$1", [
        f.ctx.attemptId,
      ]);
      await client.query("UPDATE agent_runs SET status='cancelled' WHERE id=$1", [f.ctx.runId]);
      await client.query('COMMIT');
      release.resolve();
      const result = await pending;
      expect(result.status).toBe('denied');
      expect('result' in result).toBe(false);
      expect(
        (
          await database.pool.query(
            'SELECT state,accepted_result FROM tool_invocations WHERE invocation_id=$1',
            [input.invocationId],
          )
        ).rows[0],
      ).toEqual({ state: 'reserved', accepted_result: null });
    } finally {
      await client.query('ROLLBACK');
      client.release();
      release.resolve();
      await pending;
    }
  });

  it('registry revocation before read acceptance hides actual MCP content and records no accepted source bytes', async () => {
    const f = await fresh();
    const input = await f.reserve('workspace_read', { path: 'memo.txt' });
    const outcome = await executeReadOnlyInvocation(database.pool, f.ctx, input, async (ctx) => {
      const result = await callWorkspaceMcp(ctx, 'workspace_read', { path: 'memo.txt' });
      await configureWorkspaceRegistry([]);
      return { status: 'ok', result };
    });
    expect(outcome.status).toBe('denied');
    expect('result' in outcome).toBe(false);
    expect(
      (
        await database.pool.query(
          'SELECT accepted_result FROM tool_invocations WHERE invocation_id=$1',
          [input.invocationId],
        )
      ).rows[0],
    ).toEqual({ accepted_result: null });
  });

  it('a late real apply fact survives revocation in the original ledger but is not disclosed', async () => {
    const f = await fresh();
    const receipt = await f.propose();
    await f.approve(receipt);
    const input = await f.reserve('workspace_apply_replace', { approval_id: receipt.approval_id });
    const outcome = await executeNonTransactionalInvocation(database.pool, f.ctx, input, {
      validateDispatch: async (client, ctx, binding) => {
        await validateDocumentApprovalApply(client, {
          ownerId: ctx.ownerId,
          conversationId: ctx.conversationId,
          runId: ctx.runId,
          workspaceGrant: ctx.workspaceGrant!,
          approvalId: receipt.approval_id,
          invocationId: binding.invocationId,
        });
      },
      execute: async (binding) => {
        const client = await database.pool.connect();
        try {
          const result = await applyWorkspaceReplace(
            client,
            f.ctx.ownerId,
            f.ctx.workspaceGrant!,
            {
              approval_id: receipt.approval_id,
              path: receipt.relative_path,
              base_version: receipt.base_version,
              new_version: receipt.new_version,
              exact_new_content: receipt.exact_new_content,
            },
            { invocation_id: binding.invocationId, args_hash: binding.argsHash },
          );
          if (result.kind !== 'applied') throw new Error('expected real replacement');
          await configureWorkspaceRegistry([]);
          return { ...binding, evidenceRef: result.evidence_ref, result: { status: 'ok', result } };
        } finally {
          client.release();
        }
      },
    });
    expect(outcome.status).toBe('denied');
    expect('result' in outcome).toBe(false);
    expect(
      (
        await database.pool.query(
          'SELECT state,accepted_result FROM tool_invocations WHERE invocation_id=$1',
          [input.invocationId],
        )
      ).rows[0],
    ).toMatchObject({
      state: 'completed',
      accepted_result: {
        status: 'ok',
        result: { kind: 'applied', invocation_id: input.invocationId },
      },
    });
    expect(await readFile(join(f.root, 'memo.txt'), 'utf8')).toBe(receipt.exact_new_content);
  });
});
