import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { HARNESS_PROTOCOL_VERSION, DocumentApprovalReceiptSchema } from '@along/contracts';
import { rejectDocumentApproval } from '../../src/modules/approvals/document-actions.js';
import {
  createHarnessSession,
  resumeConversationRun,
} from '../../src/modules/conversations/harness-authority.js';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import { executeReadOnlyInvocation } from '../../src/modules/tools/invocations.js';
import {
  configureWorkspaceRegistry,
  getWorkspaceGrant,
  readWorkspaceFile,
} from '../../src/modules/workspaces/service.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
maybe('delegated document rejection', () => {
  let database: IntegrationDatabase;
  const roots: string[] = [];
  beforeAll(async () => {
    database = await createIntegrationDatabase();
  });
  afterAll(async () => {
    await configureWorkspaceRegistry([]);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    await database?.close();
  });
  async function fixture(suspend: boolean) {
    const pool = database.pool;
    const actor = await seedAdmittedSession(pool, {});
    const root = await mkdtemp(join(tmpdir(), 'along-rejected-document-'));
    roots.push(root);
    await writeFile(join(root, 'brief.txt'), 'Original brief.\n');
    await configureWorkspaceRegistry([
      {
        workspace_id: 'documents',
        label: 'Documents',
        owner_id: actor.userId,
        root,
        readable_paths: ['brief.txt'],
        writable_paths: ['brief.txt'],
      },
    ]);
    const grant = getWorkspaceGrant(actor.userId, 'documents');
    const deps = {
      pool,
      timeContext: loadTimeContext('fixture-v1'),
      harness: {
        binaryPath: '/unused',
        maxIterations: 24,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({ completionCap: 512, model: 'test' }),
        model: async function* () {
          throw new Error('rejection must not call a model');
        },
      },
    };
    const started = await startConversationRun(
      deps,
      actor.userId,
      randomUUID(),
      {
        execution: 'harness',
        authorization_revision: 'delegation/1',
        raw_text: 'Edit the document.',
        idempotency_key: randomUUID(),
      },
      null,
    );
    if (!started.context) throw new Error('missing Run context');
    const context = started.context;
    const session = await createHarnessSession(
      deps,
      context,
      async () => true,
      new AbortController().signal,
    );
    const request = (type: string, fields: object) =>
      ({ protocol: HARNESS_PROTOCOL_VERSION, request_ref: randomUUID(), type, ...fields }) as never;
    const id = z.object({ invocation_id: z.string().uuid() });
    const readArgs = { workspace_id: 'documents', path: 'brief.txt' };
    const read = id.parse(
      await session.handleRequest(
        request('reserve', { call_key: 'harness/1', tool_id: 'workspace_read', args: readArgs }),
      ),
    );
    await executeReadOnlyInvocation(
      pool,
      context,
      { invocationId: read.invocation_id, toolId: 'workspace_read', args: readArgs },
      async () => ({
        status: 'ok',
        result: {
          ...(await readWorkspaceFile(actor.userId, grant, 'brief.txt')),
          workspace_id: 'documents',
        },
      }),
    );
    const args = {
      read_invocation_id: read.invocation_id,
      change: { kind: 'literal', old_text: 'Original', new_text: 'Updated' },
    };
    const proposed = id.parse(
      await session.handleRequest(
        request('reserve', { call_key: 'harness/2', tool_id: 'workspace_propose_replace', args }),
      ),
    );
    const outcome = z
      .object({
        status: z.literal('ok'),
        result: z.object({
          kind: z.literal('document_approval'),
          approval: DocumentApprovalReceiptSchema,
        }),
      })
      .parse(
        await session.handleRequest(
          request('invoke', {
            invocation_id: proposed.invocation_id,
            tool_id: 'workspace_propose_replace',
            args,
          }),
        ),
      );
    const receipt = outcome.result.approval;
    const checkpoint = z.object({ checkpoint_ref: z.string().uuid() }).parse(
      await session.handleRequest(
        request('snapshot', {
          context: {
            version: 2,
            message_refs: [context.userMessageId],
            tool_refs: [read.invocation_id, proposed.invocation_id],
            next_call_no: 3,
            usage: { iterations: 2, tokens: null },
            waiting: { invocation_id: proposed.invocation_id, approval_id: receipt.approval_id },
          },
        }),
      ),
    );
    const suspendRequest = request('suspend', {
      checkpoint_ref: checkpoint.checkpoint_ref,
      invocation_id: proposed.invocation_id,
      approval_id: receipt.approval_id,
    });
    if (suspend) await session.handleRequest(suspendRequest);
    return { actor, context, deps, session, receipt, checkpoint, suspendRequest, root };
  }

  it('atomically rejects the current waiting point without a new attempt or document write', async () => {
    const f = await fixture(true);
    const key = randomUUID();
    const reject = () =>
      rejectDocumentApproval(f.deps, f.actor.userId, f.receipt.approval_id, {
        idempotency_key: key,
      });
    expect(await reject()).toMatchObject({ status: 'rejected', duplicate: false });
    expect(await reject()).toMatchObject({ status: 'rejected', duplicate: true });
    const run = (
      await database.pool.query(
        'SELECT status,waiting_checkpoint_id,goal_result FROM agent_runs WHERE id=$1',
        [f.context.runId],
      )
    ).rows[0];
    expect(run).toMatchObject({
      status: 'cancelled',
      waiting_checkpoint_id: null,
      goal_result: { status: 'cancelled' },
    });
    expect(
      (
        await database.pool.query('SELECT count(*)::int n FROM run_attempts WHERE run_id=$1', [
          f.context.runId,
        ])
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await database.pool.query('SELECT status FROM run_attempts WHERE id=$1', [
          f.context.attemptId,
        ])
      ).rows[0].status,
    ).toBe('done');
    expect(
      (
        await database.pool.query(
          "SELECT count(*)::int n FROM run_checkpoints WHERE attempt_id=$1 AND kind='thread.cancelled'",
          [f.context.attemptId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await readFile(join(f.root, 'brief.txt'), 'utf8')).toBe('Original brief.\n');
    await expect(
      resumeConversationRun(
        f.deps,
        f.actor.userId,
        f.context.conversationId,
        f.context.runId,
        randomUUID(),
        { checkpoint_id: f.checkpoint.checkpoint_ref, idempotency_key: randomUUID() },
      ),
    ).rejects.toMatchObject({ httpStatus: 409 });
    await f.session.close();
  });

  it('rolls back the decision when terminal checkpoint persistence fails', async () => {
    const f = await fixture(true);
    const suffix = randomUUID().replaceAll('-', '');
    const fn = `reject_failure_${suffix}`;
    const trigger = `reject_trigger_${suffix}`;
    await database.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.attempt_id='${f.context.attemptId}'::uuid AND NEW.kind='thread.cancelled' THEN
        RAISE EXCEPTION 'terminal unavailable';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER ${trigger} BEFORE INSERT ON run_checkpoints FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      await expect(
        rejectDocumentApproval(f.deps, f.actor.userId, f.receipt.approval_id, {
          idempotency_key: randomUUID(),
        }),
      ).rejects.toThrow();
      expect(
        (
          await database.pool.query('SELECT state FROM document_approvals WHERE id=$1', [
            f.receipt.approval_id,
          ])
        ).rows[0].state,
      ).toBe('pending');
      expect(
        (
          await database.pool.query(
            'SELECT status,waiting_checkpoint_id FROM agent_runs WHERE id=$1',
            [f.context.runId],
          )
        ).rows[0],
      ).toEqual({
        status: 'suspended_approval',
        waiting_checkpoint_id: f.checkpoint.checkpoint_ref,
      });
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int n FROM document_approval_decisions WHERE target_approval_id=$1',
            [f.receipt.approval_id],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await database.pool.query(
        `DROP TRIGGER ${trigger} ON run_checkpoints; DROP FUNCTION ${fn}()`,
      );
      await f.session.close();
    }
  });

  it('records an early rejection but does not advance to the waiting point', async () => {
    const f = await fixture(false);
    expect(
      await rejectDocumentApproval(f.deps, f.actor.userId, f.receipt.approval_id, {
        idempotency_key: randomUUID(),
      }),
    ).toMatchObject({ status: 'rejected', duplicate: false });
    await expect(f.session.handleRequest(f.suspendRequest)).rejects.toMatchObject({
      errorCode: 'FORBIDDEN',
    });
    await expect(
      f.session.handleRequest({
        protocol: HARNESS_PROTOCOL_VERSION,
        request_ref: randomUUID(),
        type: 'reserve',
        call_key: 'harness/3',
        tool_id: 'workspace_read',
        args: { workspace_id: 'documents', path: 'brief.txt' },
      } as never),
    ).rejects.toMatchObject({ errorCode: 'FORBIDDEN' });
    expect(
      (
        await database.pool.query(
          'SELECT state,apply_invocation_id FROM document_approvals WHERE id=$1',
          [f.receipt.approval_id],
        )
      ).rows[0],
    ).toEqual({ state: 'rejected', apply_invocation_id: null });
    expect(
      (
        await database.pool.query(
          'SELECT count(*)::int n FROM document_approval_decisions WHERE target_approval_id=$1',
          [f.receipt.approval_id],
        )
      ).rows[0].n,
    ).toBe(1);
    const run = (
      await database.pool.query('SELECT status,waiting_checkpoint_id FROM agent_runs WHERE id=$1', [
        f.context.runId,
      ])
    ).rows[0];
    expect(run.waiting_checkpoint_id).toBeNull();
    expect(run.status).not.toBe('suspended_approval');
    expect(
      (
        await database.pool.query('SELECT count(*)::int n FROM run_attempts WHERE run_id=$1', [
          f.context.runId,
        ])
      ).rows[0].n,
    ).toBe(1);
    expect(
      (
        await database.pool.query('SELECT count(*)::int n FROM tool_invocations WHERE run_id=$1', [
          f.context.runId,
        ])
      ).rows[0].n,
    ).toBe(2);
    expect(await readFile(join(f.root, 'brief.txt'), 'utf8')).toBe('Original brief.\n');
    await f.session.close();
  });
});
