import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { withTransaction } from '../../src/db/transaction.js';
import { confirmDocumentApproval } from '../../src/modules/approvals/document-actions.js';
import { readDocumentApprovalReceipt } from '../../src/modules/approvals/decision.js';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { createHarnessModelTransport } from '../../src/modules/model-providers/harness-model.js';
import { RunDriver } from '../../src/modules/conversations/run-driver.js';
import type { RunOwnership } from '../../src/modules/conversations/run-ownership.js';
import {
  cancelConversationRun,
  resumeConversationRun,
  startConversationRun,
} from '../../src/modules/conversations/service.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { configureWorkspaceRegistry } from '../../src/modules/workspaces/service.js';
import { listen, sendModelSse } from '../helpers/harness-consumer.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const binaryPath = process.env.HARNESS_BINARY;
const maybe = databaseUrl && binaryPath ? describe : describe.skip;

async function until<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
) {
  const deadline = Date.now() + 15000;
  let value: T;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
}

maybe('server-owned driver retains an in-flight workspace write', () => {
  let database: IntegrationDatabase;
  let root: string;
  beforeAll(async () => {
    await access(new URL('../../dist/modules/workspaces/mcp-server.js', import.meta.url));
    database = await createIntegrationDatabase();
    root = await mkdtemp(join(tmpdir(), 'along-driver-write-'));
  });
  afterAll(async () => {
    await configureWorkspaceRegistry([]);
    if (root) await rm(root, { recursive: true, force: true });
    await database?.close();
  });

  for (const check of ['capacity', 'shutdown'] as const) {
    it(`retains ${check} until a stopped native write is accounted`, async () => {
      const actor = await seedAdmittedSession(database.pool);
      await configureTestModel(database.pool, actor.userId, 'fixture-transport-only');
      const file = join(root, 'brief.txt');
      await writeFile(file, 'Original brief.\n');
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
      const control = database.connect();
      const ownership = new Pool({ connectionString: database.connectionString, max: 2 });
      const driver = new RunDriver(ownership, 1);
      const blocker = await database.pool.connect();
      const modelEntered = Promise.withResolvers<void>();
      const releaseModel = Promise.withResolvers<void>();
      let calls = 0;
      let approvalId = '';
      const errors: string[] = [];
      const model = createServer((_req, res) => {
        void (async () => {
          calls++;
          let name: string;
          let args: object;
          if (calls === 1) {
            name = 'workspace_read';
            args = { workspace_id: 'documents', path: 'brief.txt' };
          } else if (calls === 2) {
            const read = (
              await database.pool.query(
                "SELECT invocation_id FROM tool_invocations WHERE owner_id=$1 AND tool_id='workspace_read' AND state='completed'",
                [actor.userId],
              )
            ).rows[0];
            if (!read) throw new Error('workspace read was not accepted');
            name = 'workspace_propose_replace';
            args = {
              read_invocation_id: read.invocation_id,
              change: { kind: 'literal', old_text: 'Original', new_text: 'Updated' },
            };
          } else if (calls === 3) {
            modelEntered.resolve();
            await releaseModel.promise;
            name = 'workspace_apply_replace';
            args = { approval_id: approvalId };
          } else {
            throw new Error(`unexpected model request ${calls}`);
          }
          if (!res.destroyed)
            sendModelSse(res, {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: `call-${calls}`,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
              usage: { total_tokens: 5 },
            });
        })().catch((error: unknown) => {
          errors.push(String(error));
          res.destroy();
        });
      });
      const base = await listen(model);
      const deps = {
        pool: control,
        timeContext: loadTimeContext('fixture-v1'),
        runDriver: driver,
        harness: {
          binaryPath: binaryPath!,
          libraryPath: process.env.HARNESS_LIBRARY_PATH,
          maxIterations: 8,
          maxTokens: 8000,
          contextPolicy: createContextPolicy({
            completionCap: 1024,
            model: 'fixture-transport-only',
          }),
          model: createHarnessModelTransport({
            baseUrl: `${base}/v1`,
            model: 'fixture-transport-only',
          }),
        },
      };
      controlledModelDeps(deps);
      let locked = false;
      let shutdown: Promise<void> | undefined;
      let invocationId: string | undefined;
      try {
        const started = await startConversationRun(
          deps,
          actor.userId,
          randomUUID(),
          {
            execution: 'harness',
            authorization_revision: 'delegation/1',
            raw_text:
              'Read brief.txt, propose replacing Original with Updated, and ask for approval before saving.',
            workspace_ids: ['documents'],
            idempotency_key: randomUUID(),
          },
          randomUUID(),
        );
        const suspended = await until(
          async () =>
            (
              await database.pool.query(
                'SELECT status,waiting_checkpoint_id,waiting_approval_id FROM agent_runs WHERE id=$1',
                [started.runId],
              )
            ).rows[0],
          (row) => row?.status === 'suspended_approval',
          'approval suspension',
        );
        approvalId = suspended.waiting_approval_id;
        const receipt = await withTransaction(database.pool, (client) =>
          readDocumentApprovalReceipt(client, actor.userId, approvalId),
        );
        expect(
          await confirmDocumentApproval({ pool: database.pool }, actor.userId, approvalId, {
            presentation_hash: receipt.presentation_hash,
            seen_content: receipt.preview.body,
            idempotency_key: randomUUID(),
          }),
        ).toMatchObject({ status: 'approved', duplicate: false });
        // Wait until the first suspended attempt has relinquished the single slot.
        const available = await until(
          async () => {
            try {
              return await driver.acquire(randomUUID());
            } catch {
              return null;
            }
          },
          (owner) => owner !== null,
          'suspended attempt slot release',
        );
        const resumeRequest = {
          checkpoint_id: suspended.waiting_checkpoint_id,
          idempotency_key: randomUUID(),
        };
        try {
          await expect(
            resumeConversationRun(
              deps,
              actor.userId,
              started.conversationId,
              started.runId,
              randomUUID(),
              resumeRequest,
            ),
          ).rejects.toMatchObject({ httpStatus: 409 });
          expect(
            (
              await database.pool.query(
                'SELECT count(*)::int AS n FROM harness_resumes WHERE run_id=$1',
                [started.runId],
              )
            ).rows[0].n,
          ).toBe(0);
        } finally {
          await driver.release(available!);
        }
        await resumeConversationRun(
          deps,
          actor.userId,
          started.conversationId,
          started.runId,
          randomUUID(),
          resumeRequest,
        );
        expect(
          (
            await database.pool.query(
              'SELECT count(*)::int AS n FROM harness_resumes WHERE run_id=$1 AND idempotency_key=$2',
              [started.runId, resumeRequest.idempotency_key],
            )
          ).rows[0].n,
        ).toBe(1);
        await Promise.race([
          modelEntered.promise,
          delay(15000).then(() => {
            throw new Error(`resumed model not called: ${errors}`);
          }),
        ]);
        // This is the exact advisory key used by publishWorkspaceReplace. Its
        // dedicated production PG connection must wait after dispatch commits.
        await blocker.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
          'along:workspace:documents',
        ]);
        locked = true;
        releaseModel.resolve();
        const invocation = await until(
          async () =>
            (
              await database.pool.query(
                "SELECT invocation_id,state FROM tool_invocations WHERE run_id=$1 AND tool_id='workspace_apply_replace'",
                [started.runId],
              )
            ).rows[0],
          (row) => row?.state === 'unknown',
          'committed workspace dispatch',
        );
        invocationId = invocation.invocation_id;
        const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
        await until(
          async () =>
            (
              await database.pool.query(
                `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database()
           AND wait_event_type='Lock' AND wait_event='advisory'
           AND $1 = ANY(pg_blocking_pids(pid))`,
                [blockerPid],
              )
            ).rows[0].n,
          (n) => n > 0,
          'workspace write waiting on PostgreSQL advisory lock',
        );
        expect(await readFile(file, 'utf8')).toBe('Original brief.\n');
        expect(
          (
            await cancelConversationRun(
              { pool: control, timeContext: deps.timeContext },
              actor.userId,
              started.conversationId,
              started.runId,
              randomUUID(),
              { idempotency_key: randomUUID() },
            )
          ).status,
        ).toBe('cancelled');
        await delay(1500);
        if (check === 'capacity') {
          let acquired: RunOwnership | undefined;
          try {
            acquired = await driver.acquire(randomUUID());
          } catch {
            /* capacity unavailable */
          }
          if (acquired) await driver.release(acquired);
          expect(acquired).toBeUndefined();
        } else {
          let settled = false;
          shutdown = driver.shutdown().finally(() => {
            settled = true;
          });
          await delay(1000);
          expect(settled).toBe(false);
        }
        expect(await readFile(file, 'utf8')).toBe('Original brief.\n');
        await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
          'along:workspace:documents',
        ]);
        locked = false;
        const record = await until(
          async () =>
            (
              await database.pool.query(
                'SELECT state,accepted_result,evidence_ref FROM tool_invocations WHERE invocation_id=$1',
                [invocation.invocation_id],
              )
            ).rows[0],
          (row) => row?.state === 'completed',
          'late effect accounting',
        );
        expect(record).toMatchObject({
          state: 'completed',
          accepted_result: {
            status: 'ok',
            result: { kind: 'applied', invocation_id: invocation.invocation_id },
          },
        });
        expect(record.evidence_ref).toContain(`workspace-apply:${invocation.invocation_id}:`);
        expect(await readFile(file, 'utf8')).toBe('Updated brief.\n');
        expect(
          (await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [started.runId]))
            .rows[0],
        ).toEqual({ status: 'cancelled' });
        expect(errors).toEqual([]);
        if (shutdown) await shutdown;
      } finally {
        releaseModel.resolve();
        if (locked)
          await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [
            'along:workspace:documents',
          ]);
        blocker.release();
        if (invocationId) {
          await until(
            async () =>
              (
                await database.pool.query(
                  'SELECT state FROM tool_invocations WHERE invocation_id=$1',
                  [invocationId],
                )
              ).rows[0]?.state,
            (state) => state === 'completed',
            'cleanup of dispatched effect',
          ).catch(() => undefined);
        }
        await (shutdown ?? driver.shutdown());
        await control.end();
        const closed = once(model, 'close');
        model.closeAllConnections();
        model.close();
        await closed;
      }
    }, 60000);
  }
});
