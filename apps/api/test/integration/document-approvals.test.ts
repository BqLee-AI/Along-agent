import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { DocumentApprovalActionResult, DocumentApprovalReceipt } from '@along/contracts';
import { withTransaction } from '../../src/db/transaction.js';
import {
  confirmDocumentApproval,
  rejectDocumentApproval,
} from '../../src/modules/approvals/document-actions.js';
import {
  bindDocumentApprovalApply,
  createDocumentApproval,
  DocumentProposalOperationError,
  validateDocumentApprovalApply,
  validateDocumentApprovalsDone,
} from '../../src/modules/approvals/document-service.js';
import {
  readDocumentApprovalDecision,
  readDocumentApprovalReceipt,
} from '../../src/modules/approvals/decision.js';
import type { CreateDocumentApprovalInput } from '../../src/modules/approvals/document-evidence.js';
import {
  configureWorkspaceRegistry,
  getWorkspaceGrant,
  readWorkspaceFile,
} from '../../src/modules/workspaces/service.js';
import {
  executeLocalInvocation,
  executeNonTransactionalInvocation,
  executeReadOnlyInvocation,
  reserveInvocation,
} from '../../src/modules/tools/invocations.js';
import { readRunDocumentEvidence } from '../../src/modules/tools/query.js';
import { seedSession } from '../../src/modules/identity/seed.js';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { createIntegrationDatabase, databaseUrl, type IntegrationDatabase } from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
maybe('document approval PostgreSQL authority and frozen content', () => {
  let database: IntegrationDatabase;
  let pool: Pool;
  const roots: string[] = [];
  beforeAll(async () => {
    database = await createIntegrationDatabase();
    pool = database.pool;
  });
  afterAll(async () => {
    await configureWorkspaceRegistry([]);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    await database?.close();
  });
  async function fresh(content = '\uFEFFprefix\r\nold  \r\nsuffix\n') {
    const actor = await seedSession(pool, {});
    const root = await mkdtemp(join(process.cwd(), '.document-approval-test-'));
    roots.push(root);
    await writeFile(join(root, 'memo.txt'), content);
    await writeFile(join(root, 'other.txt'), content);
    await configureWorkspaceRegistry([
      {
        workspace_id: 'document-test',
        label: 'Documents',
        owner_id: actor.userId,
        root,
        readable_paths: ['memo.txt', 'other.txt'],
        writable_paths: ['memo.txt', 'other.txt'],
      },
    ]);
    const workspaceGrant = getWorkspaceGrant(actor.userId, 'document-test');
    const started = await startConversationRun(
      {
        pool,
        timeContext: loadTimeContext('fixture-v1'),
        harness: {
          binaryPath: process.env.HARNESS_BINARY ?? '/app/harness/bin/along-harness',
          maxIterations: 24,
          maxTokens: 8000,
          model: async () => {
            throw new Error('approval tests never invoke a model');
          },
        },
      },
      actor.userId,
      randomUUID(),
      {
        execution: 'harness',
        workspace_id: 'document-test',
        raw_text: 'Replace the document literal.',
        idempotency_key: randomUUID(),
      },
      null,
    );
    if (!started.context) throw new Error('real harness Run context missing');
    const ctx = started.context;
    const readArgs = { path: 'memo.txt' };
    const reserved = await reserveInvocation(pool, ctx, {
      callKey: 'read/1',
      toolId: 'workspace_read',
      args: readArgs,
      executionKind: 'read_only',
    });
    await executeReadOnlyInvocation(
      pool,
      ctx,
      { invocationId: reserved.invocationId, toolId: 'workspace_read', args: readArgs },
      async () => ({
        status: 'ok',
        result: await readWorkspaceFile(ctx.ownerId, ctx.workspaceGrant!, 'memo.txt'),
      }),
    );
    const evidence = await withTransaction(pool, (client) => readRunDocumentEvidence(client, ctx));
    const baseRead = evidence.reads[0];
    if (!baseRead) throw new Error('accepted read fixture missing');
    const input: CreateDocumentApprovalInput = {
      ownerId: ctx.ownerId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      workspaceGrant,
      relativePath: 'memo.txt',
      baseRead,
      oldText: 'old',
      newText: 'new',
      evidence,
    };
    async function propose(
      change: Partial<CreateDocumentApprovalInput> = {},
      failAfterCreate = false,
    ): Promise<DocumentApprovalReceipt> {
      const actual = { ...input, ...change };
      const args = {
        read_invocation_id: actual.baseRead.invocation_id,
        old_text: actual.oldText,
        new_text: actual.newText,
      };
      const reservation = await reserveInvocation(pool, ctx, {
        callKey: `proposal/${randomUUID()}`,
        toolId: 'workspace_propose_replace',
        args,
        executionKind: 'local',
      });
      const outcome = await executeLocalInvocation(
        pool,
        ctx,
        { invocationId: reservation.invocationId, toolId: 'workspace_propose_replace', args },
        async (client) => {
          const receipt = await createDocumentApproval(client, actual);
          if (failAfterCreate) throw new Error('acceptance unavailable');
          return { status: 'ok', result: { kind: 'document_approval', approval: receipt } };
        },
      );
      if (outcome.status !== 'ok' || outcome.result.kind !== 'document_approval')
        throw new Error('proposal was not accepted');
      return outcome.result.approval;
    }
    return { ctx, root, input, propose };
  }
  function confirmBody(receipt: DocumentApprovalReceipt, idempotency_key = randomUUID()) {
    return {
      presentation_hash: receipt.presentation_hash,
      seen_content: receipt.preview.body,
      idempotency_key,
    };
  }
  it('reapplies migration 0016 without rebuilding authority or altering previous ledgers', async () => {
    const before = (await pool.query('SELECT version FROM schema_migrations ORDER BY version'))
      .rows;
    const migration = await readFile(
      new URL('../../../../infra/migrations/0016_document_approvals.sql', import.meta.url),
      'utf8',
    );
    await pool.query(migration);
    expect(
      (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows,
    ).toEqual(before);
    expect(before.filter((row: { version: string }) => row.version === '0016')).toHaveLength(1);
  });
  it('freezes a real accepted read and exact preview; confirm authorizes only and persistent replay retains original decision', async () => {
    const f = await fresh();
    const receipt = await f.propose();
    const original = await readFile(join(f.root, 'memo.txt'));
    expect(receipt.exact_new_content).toBe('\uFEFFprefix\r\nnew  \r\nsuffix\n');
    const body = confirmBody(receipt);
    expect(
      await confirmDocumentApproval({ pool }, f.ctx.ownerId, receipt.approval_id, body),
    ).toEqual({ approval_id: receipt.approval_id, status: 'approved', duplicate: false });
    expect(
      await confirmDocumentApproval({ pool }, f.ctx.ownerId, receipt.approval_id, body),
    ).toMatchObject({ status: 'approved', duplicate: true });
    expect(await readFile(join(f.root, 'memo.txt'))).toEqual(original);
    expect((await pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0]?.n).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM document_approval_decisions WHERE target_approval_id=$1',
          [receipt.approval_id],
        )
      ).rows[0]?.n,
    ).toBe(1);
    expect(
      await withTransaction(pool, (client) =>
        readDocumentApprovalDecision(client, f.ctx.ownerId, receipt.approval_id),
      ),
    ).toMatchObject({ kind: 'document', status: 'approved', apply_invocation_id: null });
    expect(
      await withTransaction(pool, (client) =>
        readDocumentApprovalReceipt(client, f.ctx.ownerId, receipt.approval_id),
      ),
    ).toEqual(receipt);
    await expect(
      confirmDocumentApproval({ pool }, f.ctx.ownerId, receipt.approval_id, {
        ...body,
        seen_content: body.seen_content + ' ',
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });
    await expect(
      rejectDocumentApproval({ pool }, f.ctx.ownerId, receipt.approval_id, {
        idempotency_key: randomUUID(),
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });
  it('rejects a quote-heavy proposal whose serialized confirmation exceeds the HTTP body bound before persisting approval or suspension', async () => {
    const content = '"'.repeat(36_000);
    const f = await fresh(content);
    expect(f.input.baseRead.result.content).toBe(content);
    const proposal = f.propose({ oldText: content, newText: 'x' });
    await expect(proposal).rejects.toBeInstanceOf(DocumentProposalOperationError);
    await expect(proposal).rejects.toMatchObject({
      reason: 'range_too_large',
    });
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM document_approvals WHERE run_id=$1', [
          f.ctx.runId,
        ])
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM document_approval_decisions WHERE owner_id=$1',
          [f.ctx.ownerId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM tool_invocations WHERE run_id=$1 AND tool_id='workspace_apply_replace'",
          [f.ctx.runId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT status,waiting_checkpoint_id,waiting_invocation_id,waiting_approval_id FROM agent_runs WHERE id=$1',
          [f.ctx.runId],
        )
      ).rows[0],
    ).toEqual({
      status: 'running',
      waiting_checkpoint_id: null,
      waiting_invocation_id: null,
      waiting_approval_id: null,
    });
    expect(await readFile(join(f.root, 'memo.txt'), 'utf8')).toBe(content);
  });
  it('keeps a near-boundary escaped preview with BOM and CRLF exactly confirmable', async () => {
    const oldText = '"'.repeat(32_000);
    const content = '\uFEFF\r\n' + oldText + '\\\t\r\n尾\n';
    const f = await fresh(content);
    const receipt = await f.propose({ oldText, newText: 'x' });
    const body = confirmBody(receipt);
    const requestBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    expect(requestBytes).toBeGreaterThan(128_000);
    expect(requestBytes).toBeLessThanOrEqual(131_072);
    expect(receipt.preview.before).toBe(content);
    expect(receipt.exact_new_content).toBe('\uFEFF\r\nx\\\t\r\n尾\n');
    expect(
      await confirmDocumentApproval({ pool }, f.ctx.ownerId, receipt.approval_id, body),
    ).toMatchObject({ status: 'approved', duplicate: false });
    expect(await readFile(join(f.root, 'memo.txt'), 'utf8')).toBe(content);
  });
  it('rejects preview/hash mismatch, another owner and accepted read forgery without deciding', async () => {
    const f = await fresh();
    await expect(
      f.propose({ baseRead: { ...f.input.baseRead, run_id: randomUUID() } }),
    ).rejects.toThrow();
    const receipt = await f.propose();
    await expect(
      confirmDocumentApproval({ pool }, randomUUID(), receipt.approval_id, confirmBody(receipt)),
    ).rejects.toMatchObject({ httpStatus: 403 });
    await expect(
      confirmDocumentApproval({ pool }, f.ctx.ownerId, receipt.approval_id, {
        ...confirmBody(receipt),
        seen_content: receipt.preview.body.trim() + '\n',
      }),
    ).rejects.toMatchObject({ errorCode: 'PRESENTATION_MISMATCH' });
    await expect(
      confirmDocumentApproval({ pool }, f.ctx.ownerId, receipt.approval_id, {
        ...confirmBody(receipt),
        presentation_hash: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ errorCode: 'PRESENTATION_MISMATCH' });
    expect(
      (await pool.query('SELECT state FROM document_approvals WHERE id=$1', [receipt.approval_id]))
        .rows[0]?.state,
    ).toBe('pending');
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM document_approval_decisions WHERE target_approval_id=$1',
          [receipt.approval_id],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });
  it('rolls back the approval with invocation acceptance failure and rejects ambiguous, unchanged, stale and untried replacement proposals', async () => {
    const f = await fresh();
    await expect(f.propose({}, true)).rejects.toThrow('acceptance unavailable');
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM document_approvals WHERE run_id=$1', [
          f.ctx.runId,
        ])
      ).rows[0]?.n,
    ).toBe(0);
    await expect(f.propose({ oldText: '', newText: 'new' })).rejects.toThrow();
    await expect(f.propose({ oldText: 'old', newText: 'old' })).rejects.toThrow();
    await expect(f.propose({ oldText: 'missing' })).rejects.toThrow();
    await expect(f.propose({ oldText: 'i' })).rejects.toThrow();
    await writeFile(join(f.root, 'memo.txt'), 'externally changed');
    await expect(f.propose()).rejects.toThrow('version_changed');
    await writeFile(join(f.root, 'memo.txt'), f.input.baseRead.result.content);
    const receipt = await f.propose();
    await confirmDocumentApproval(
      { pool },
      f.ctx.ownerId,
      receipt.approval_id,
      confirmBody(receipt),
    );
    await expect(f.propose()).rejects.toThrow('zero-write conflict');
  });
  it('binds one apply invocation immutably and validates the same binding at dispatch', async () => {
    const f = await fresh();
    const receipt = await f.propose();
    await confirmDocumentApproval(
      { pool },
      f.ctx.ownerId,
      receipt.approval_id,
      confirmBody(receipt),
    );
    async function reserveApply(slot: string) {
      return reserveInvocation(pool, f.ctx, {
        callKey: slot,
        toolId: 'workspace_apply_replace',
        args: { approval_id: receipt.approval_id },
        executionKind: 'non_transactional',
      });
    }
    const first = await reserveApply('apply/first');
    const binding = {
      ...f.ctx,
      approvalId: receipt.approval_id,
      invocationId: first.invocationId,
      workspaceGrant: f.input.workspaceGrant,
    };
    await withTransaction(pool, (client) => bindDocumentApprovalApply(client, binding));
    await withTransaction(pool, (client) => validateDocumentApprovalApply(client, binding));
    await expect(reserveApply('apply/another')).rejects.toThrow();
    await expect(
      pool.query('UPDATE document_approvals SET apply_invocation_id=$2 WHERE id=$1', [
        receipt.approval_id,
        randomUUID(),
      ]),
    ).rejects.toThrow();
    await expect(
      withTransaction(pool, (client) =>
        validateDocumentApprovalApply(client, { ...binding, runId: randomUUID() }),
      ),
    ).rejects.toThrow();
  });
  it('keeps real zero-write conflict rows immutable, creates one successor, and refuses pending successor done', async () => {
    const f = await fresh();
    const first = await f.propose();
    await confirmDocumentApproval({ pool }, f.ctx.ownerId, first.approval_id, confirmBody(first));
    const args = { approval_id: first.approval_id };
    const reserved = await reserveInvocation(pool, f.ctx, {
      callKey: 'apply/conflict',
      toolId: 'workspace_apply_replace',
      args,
      executionKind: 'non_transactional',
    });
    const conflict = await executeNonTransactionalInvocation(
      pool,
      f.ctx,
      {
        invocationId: reserved.invocationId,
        toolId: 'workspace_apply_replace',
        args,
      },
      {
        validateDispatch: async (client, _context, binding) => {
          await validateDocumentApprovalApply(client, {
            ...f.ctx,
            workspaceGrant: f.input.workspaceGrant,
            approvalId: first.approval_id,
            invocationId: binding.invocationId,
          });
        },
        execute: async (binding) => ({
          ...binding,
          evidenceRef: 'document-test:zero-write-conflict',
          result: {
            status: 'ok',
            result: {
              kind: 'conflict',
              workspace_id: first.workspace_id,
              path: first.relative_path,
              approval_id: first.approval_id,
              invocation_id: binding.invocationId,
              args_hash: binding.argsHash,
              base_version: first.base_version,
              actual_version: first.base_version,
              reason: 'identity_changed',
              zero_write: true,
            },
          },
        }),
      },
    );
    expect(conflict.status).toBe('ok');
    const frozenBefore = (
      await pool.query('SELECT * FROM document_approvals WHERE id=$1', [first.approval_id])
    ).rows[0];
    const readArgs = { path: 'memo.txt' };
    const reread = await reserveInvocation(pool, f.ctx, {
      callKey: 'read/after-conflict',
      toolId: 'workspace_read',
      args: readArgs,
      executionKind: 'read_only',
    });
    await executeReadOnlyInvocation(
      pool,
      f.ctx,
      {
        invocationId: reread.invocationId,
        toolId: 'workspace_read',
        args: readArgs,
      },
      async () => ({
        status: 'ok',
        result: await readWorkspaceFile(f.ctx.ownerId, f.input.workspaceGrant, 'memo.txt'),
      }),
    );
    const evidence = await withTransaction(pool, (client) =>
      readRunDocumentEvidence(client, f.ctx),
    );
    const baseRead = evidence.reads.find((read) => read.invocation_id === reread.invocationId);
    if (!baseRead) throw new Error('fresh conflict read missing');
    await expect(f.propose({ evidence })).rejects.toThrow('zero-write conflict');
    const successor = await f.propose({ baseRead, evidence });
    expect(successor.replaces_approval_id).toBe(first.approval_id);
    expect(
      (await pool.query('SELECT * FROM document_approvals WHERE id=$1', [first.approval_id]))
        .rows[0],
    ).toEqual(frozenBefore);
    await expect(
      pool.query(
        `INSERT INTO document_approvals
      (id,owner_id,conversation_id,run_id,workspace_id,workspace_grant,relative_path,base_read_invocation_id,
       base_version,exact_new_content,new_version,presentation_version,presentation_hash,preview,replaces_approval_id)
      SELECT $2,owner_id,conversation_id,run_id,workspace_id,workspace_grant,relative_path,base_read_invocation_id,
       base_version,exact_new_content,new_version,presentation_version,presentation_hash,preview,replaces_approval_id
      FROM document_approvals WHERE id=$1`,
        [successor.approval_id, randomUUID()],
      ),
    ).rejects.toThrow();
    await expect(f.propose({ baseRead, evidence })).rejects.toThrow();
    await expect(
      withTransaction(pool, (client) => validateDocumentApprovalsDone(client, f.ctx, evidence)),
    ).rejects.toMatchObject({ httpStatus: 409 });
    await rejectDocumentApproval({ pool }, f.ctx.ownerId, successor.approval_id, {
      idempotency_key: randomUUID(),
    });
    await expect(
      withTransaction(pool, (client) => validateDocumentApprovalsDone(client, f.ctx, evidence)),
    ).rejects.toMatchObject({ httpStatus: 409 });
    await expect(
      pool.query('UPDATE document_approvals SET replaces_approval_id=NULL WHERE id=$1', [
        successor.approval_id,
      ]),
    ).rejects.toThrow();
  });
  it('binds persistent idempotency to the target and protects global apply invocation uniqueness', async () => {
    const f = await fresh();
    const first = await f.propose();
    const key = randomUUID();
    await confirmDocumentApproval(
      { pool },
      f.ctx.ownerId,
      first.approval_id,
      confirmBody(first, key),
    );
    const readArgs = { path: 'other.txt' };
    const reserved = await reserveInvocation(pool, f.ctx, {
      callKey: 'read/other-target',
      toolId: 'workspace_read',
      args: readArgs,
      executionKind: 'read_only',
    });
    await executeReadOnlyInvocation(
      pool,
      f.ctx,
      {
        invocationId: reserved.invocationId,
        toolId: 'workspace_read',
        args: readArgs,
      },
      async () => ({
        status: 'ok',
        result: await readWorkspaceFile(f.ctx.ownerId, f.input.workspaceGrant, 'other.txt'),
      }),
    );
    const evidence = await withTransaction(pool, (client) =>
      readRunDocumentEvidence(client, f.ctx),
    );
    const baseRead = evidence.reads.find((read) => read.invocation_id === reserved.invocationId);
    if (!baseRead) throw new Error('other target read missing');
    const second = await f.propose({ relativePath: 'other.txt', baseRead, evidence });
    await expect(
      confirmDocumentApproval(
        { pool },
        f.ctx.ownerId,
        second.approval_id,
        confirmBody(second, key),
      ),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(
      (await pool.query('SELECT state FROM document_approvals WHERE id=$1', [second.approval_id]))
        .rows[0]?.state,
    ).toBe('pending');
    await confirmDocumentApproval({ pool }, f.ctx.ownerId, second.approval_id, confirmBody(second));
    const apply = await reserveInvocation(pool, f.ctx, {
      callKey: 'apply/unique-target',
      toolId: 'workspace_apply_replace',
      args: { approval_id: first.approval_id },
      executionKind: 'non_transactional',
    });
    await expect(
      withTransaction(pool, (client) =>
        bindDocumentApprovalApply(client, {
          ...f.ctx,
          workspaceGrant: f.input.workspaceGrant,
          approvalId: second.approval_id,
          invocationId: apply.invocationId,
        }),
      ),
    ).rejects.toThrow();
    expect(
      (
        await pool.query('SELECT apply_invocation_id FROM document_approvals WHERE id=$1', [
          second.approval_id,
        ])
      ).rows[0]?.apply_invocation_id,
    ).toBeNull();
  });
  it('serializes concurrent decisions, prevents terminal authorization, and retains append-only frozen rows', async () => {
    const f = await fresh();
    const receipt = await f.propose();
    const results = await Promise.allSettled([
      confirmDocumentApproval({ pool }, f.ctx.ownerId, receipt.approval_id, confirmBody(receipt)),
      rejectDocumentApproval({ pool }, f.ctx.ownerId, receipt.approval_id, {
        idempotency_key: randomUUID(),
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(
      pool.query("UPDATE document_approvals SET exact_new_content='tampered' WHERE id=$1", [
        receipt.approval_id,
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query("UPDATE document_approvals SET state='pending' WHERE id=$1", [
        receipt.approval_id,
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query('DELETE FROM document_approvals WHERE id=$1', [receipt.approval_id]),
    ).rejects.toThrow();
    await expect(
      pool.query(
        'UPDATE document_approval_decisions SET request_hash=$2 WHERE target_approval_id=$1',
        [receipt.approval_id, 'a'.repeat(64)],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query('DELETE FROM document_approval_decisions WHERE target_approval_id=$1', [
        receipt.approval_id,
      ]),
    ).rejects.toThrow();
    const cancelled = await fresh();
    const pending = await cancelled.propose();
    const cancelling = await pool.connect();
    let attempted: Promise<DocumentApprovalActionResult>;
    try {
      await cancelling.query('BEGIN');
      await cancelling.query('SELECT id FROM run_attempts WHERE id=$1 FOR UPDATE', [
        cancelled.ctx.attemptId,
      ]);
      await cancelling.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE', [
        cancelled.ctx.runId,
      ]);
      attempted = confirmDocumentApproval(
        { pool },
        cancelled.ctx.ownerId,
        pending.approval_id,
        confirmBody(pending),
      );
      await cancelling.query(
        "UPDATE run_attempts SET status='fenced_out',ended_at=clock_timestamp() WHERE id=$1",
        [cancelled.ctx.attemptId],
      );
      await cancelling.query(
        "UPDATE agent_runs SET status='cancelled',ended_at=clock_timestamp() WHERE id=$1",
        [cancelled.ctx.runId],
      );
      await cancelling.query('COMMIT');
    } finally {
      await cancelling.query('ROLLBACK');
      cancelling.release();
    }
    await expect(attempted).rejects.toMatchObject({ httpStatus: 409 });
    expect(
      (await pool.query('SELECT state FROM document_approvals WHERE id=$1', [pending.approval_id]))
        .rows[0]?.state,
    ).toBe('pending');
  });
});
