import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction } from '../../src/db/transaction.js';
import { confirmDocumentApproval } from '../../src/agent/run/approvals/document-decision.js';
import { readDocumentApprovalReceipt } from '../../src/features/approvals/decision.js';
import { configureWorkspaceRegistry } from '../../src/features/workspaces/public.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import { createLocalFixtureModelTransport } from '../helpers/local-fixture-model.js';
import { createRunDriver } from '../../src/agent/execution/driver/driver.js';
import { startConversationRun } from '../../src/agent/run/admit-message.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import { listen, sendModelSse } from '../helpers/harness-consumer.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const binaryPath = process.env.HARNESS_BINARY;
const maybe = databaseUrl && binaryPath ? describe : describe.skip;

async function waitUntil<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  diagnose: () => Promise<string>,
): Promise<T> {
  const deadline = Date.now() + 15000;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for persisted Run state: ${await diagnose()}`);
}

maybe('server-owned approval resume across processes', () => {
  let database: IntegrationDatabase;
  let modelServer: Server;
  let modelBase: string;
  let modelCalls = 0;
  const modelErrors: string[] = [];
  const resumedModel = Promise.withResolvers<void>();
  const releaseModel = Promise.withResolvers<void>();
  let root: string;
  let ownerId: string;
  let approvalId: string;

  beforeAll(async () => {
    try {
      await access(new URL('../../dist/features/workspaces/mcp/mcp-server.js', import.meta.url));
    } catch {
      throw new Error(
        'Build apps/api/dist/features/workspaces/mcp/mcp-server.js before running this native workspace test',
      );
    }
    database = await createIntegrationDatabase();
    root = await mkdtemp(join(tmpdir(), 'along-resume-race-'));
    await writeFile(join(root, 'brief.txt'), 'Original brief.\n');
    modelServer = createServer((_req, res) => {
      void (async () => {
        modelCalls++;
        let name: string;
        let args: object;
        if (modelCalls === 1 || modelCalls === 4) {
          name = 'workspace_read';
          args = { workspace_id: 'documents', path: 'brief.txt' };
        } else if (modelCalls === 2) {
          const read = (
            await database.pool.query(
              "SELECT invocation_id,accepted_result FROM tool_invocations WHERE owner_id=$1 AND tool_id='workspace_read' AND state='completed'",
              [ownerId],
            )
          ).rows[0];
          if (
            read?.accepted_result?.status !== 'ok' ||
            read.accepted_result.result?.kind !== 'read'
          )
            throw new Error(`native read was not accepted: ${JSON.stringify(read ?? null)}`);
          name = 'workspace_propose_replace';
          args = {
            read_invocation_id: read.invocation_id,
            change: { kind: 'literal', old_text: 'Original', new_text: 'Updated' },
          };
        } else if (modelCalls === 3) {
          resumedModel.resolve();
          await releaseModel.promise;
          name = 'workspace_apply_replace';
          args = { approval_id: approvalId };
        } else {
          name = 'finish_goal';
          const refs = (
            await database.pool.query(
              "SELECT invocation_id FROM tool_invocations WHERE owner_id=$1 AND state='completed' AND tool_id IN ('workspace_read','workspace_apply_replace')",
              [ownerId],
            )
          ).rows.map((row) => row.invocation_id);
          args = {
            status: 'completed',
            outcomes: [{ description: '文档已更新', status: 'achieved', receipt_refs: refs }],
            clarification: null,
            answer: '完成',
          };
        }
        if (!res.destroyed)
          sendModelSse(res, {
            message: {
              content: null,
              tool_calls: [
                {
                  id: `call-${modelCalls}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
            usage: { total_tokens: 5 },
          });
      })().catch((error: unknown) => {
        modelErrors.push(String(error));
        res.writeHead(500);
        res.end();
      });
    });
    modelBase = await listen(modelServer);
  });

  afterAll(async () => {
    releaseModel.resolve();
    if (modelServer) {
      const closed = once(modelServer, 'close');
      modelServer.closeAllConnections();
      modelServer.close();
      await closed;
    }
    await configureWorkspaceRegistry([]);
    if (root) await rm(root, { recursive: true, force: true });
    await database?.close();
  });

  it('admits one resumed attempt, rejects its competing owner, and never retries execution', async () => {
    const actor = await seedAdmittedSession(database.pool, {});
    await configureTestModel(database.pool, actor.userId, 'fixture-transport-only');
    ownerId = actor.userId;
    await configureWorkspaceRegistry([
      {
        workspace_id: 'documents',
        label: 'Documents',
        owner_id: ownerId,
        root,
        readable_paths: ['brief.txt'],
        writable_paths: ['brief.txt'],
      },
    ]);
    const driver = createRunDriver(database.pool);
    const deps = {
      pool: database.pool,
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
        model: createLocalFixtureModelTransport({
          baseUrl: `${modelBase}/v1`,
          model: 'fixture-transport-only',
        }),
      },
    };
    controlledModelDeps(deps);
    const children: Bun.Subprocess<'pipe', 'pipe', 'pipe'>[] = [];
    let completed = false;
    try {
      const started = await startConversationRun(
        deps,
        actor.userId,
        randomUUID(),
        {
          execution: 'harness',
          authorization_revision: 'delegation/1',
          raw_text:
            'Read brief.txt, propose replacing Original with Updated, and ask for approval before saving. Independently read it back.',
          workspace_ids: ['documents'],
          idempotency_key: randomUUID(),
        },
        randomUUID(),
      );
      expect(started.serverOwned).toBe(true);
      const diagnose = async () =>
        JSON.stringify({
          modelCalls,
          modelErrors,
          run: (
            await database.pool.query(
              'SELECT status,waiting_checkpoint_id,waiting_approval_id FROM agent_runs WHERE id=$1',
              [started.runId],
            )
          ).rows,
          attempts: (
            await database.pool.query(
              'SELECT id,attempt_no,status FROM run_attempts WHERE run_id=$1 ORDER BY attempt_no',
              [started.runId],
            )
          ).rows,
          checkpoints: (
            await database.pool.query(
              `SELECT c.kind,c.payload FROM run_checkpoints c JOIN run_attempts a ON a.id=c.attempt_id
           WHERE a.run_id=$1 ORDER BY c.event_seq`,
              [started.runId],
            )
          ).rows,
          invocations: (
            await database.pool.query(
              'SELECT tool_id,state,accepted_result FROM tool_invocations WHERE run_id=$1 ORDER BY created_at',
              [started.runId],
            )
          ).rows,
        });
      const waiting = await waitUntil(
        async () =>
          (
            await database.pool.query(
              'SELECT status,waiting_checkpoint_id,waiting_approval_id FROM agent_runs WHERE id=$1',
              [started.runId],
            )
          ).rows[0],
        (row) => row?.status === 'suspended_approval',
        diagnose,
      );
      expect(waiting.waiting_checkpoint_id).toBeTruthy();
      expect(waiting.waiting_approval_id).toBeTruthy();
      approvalId = waiting.waiting_approval_id;
      const receipt = await withTransaction(database.pool, (client) =>
        readDocumentApprovalReceipt(client, actor.userId, approvalId),
      );
      const confirmed = await confirmDocumentApproval(
        { pool: database.pool },
        actor.userId,
        approvalId,
        {
          presentation_hash: receipt.presentation_hash,
          seen_content: receipt.preview.body,
          idempotency_key: randomUUID(),
        },
      );
      expect(confirmed).toMatchObject({ status: 'approved', duplicate: false });

      // Each contender constructs its own control pool and driver (and therefore
      // its own PostgreSQL advisory-lock session). Keep both processes alive
      // until the winner's actual native execution is released.
      const source = `
        import { Pool } from 'pg';
        import { httpStatusForError } from '@along/contracts';
        import { ApplicationError } from './src/platform/errors.ts';
        import { randomUUID } from 'node:crypto';
        import { once } from 'node:events';
        import { createContextPolicy } from './src/features/conversations/public.ts';
        import { createLocalFixtureModelTransport } from './test/helpers/local-fixture-model.ts';
        import { createRunDriver } from './src/agent/execution/driver/driver.ts';
        import { resumeConversationRun } from './src/agent/run/run-actions.ts';
        import { loadTimeContext } from './src/features/time/context.ts';
        import { configureWorkspaceRegistry } from './src/features/workspaces/registry/service.ts';
        import { controlledModelDeps } from './test/helpers/model-selection.ts';
        await configureWorkspaceRegistry([{ workspace_id: 'documents', label: 'Documents',
          owner_id: process.env.RACE_OWNER, root: process.env.RACE_ROOT,
          readable_paths: ['brief.txt'], writable_paths: ['brief.txt'] }]);
        const pool = new Pool({ connectionString: process.env.RACE_DATABASE });
        const driver = createRunDriver(pool);
        const deps = { pool, runDriver: driver, timeContext: loadTimeContext('fixture-v1'),
          harness: { binaryPath: process.env.HARNESS_BINARY, libraryPath: process.env.HARNESS_LIBRARY_PATH,
            maxIterations: 8, maxTokens: 8000,
            contextPolicy: createContextPolicy({ completionCap: 1024, model: 'fixture-transport-only' }),
            model: createLocalFixtureModelTransport({ baseUrl: process.env.RACE_MODEL + '/v1', model: 'fixture-transport-only' }) } };
        controlledModelDeps(deps);
        console.log(JSON.stringify({ ready: true }));
        await once(process.stdin, 'data');
        try {
          const result = await resumeConversationRun(deps, process.env.RACE_OWNER, process.env.RACE_CONVERSATION,
            process.env.RACE_RUN, randomUUID(), { checkpoint_id: process.env.RACE_CHECKPOINT, idempotency_key: randomUUID() });
          console.log(JSON.stringify({ ok: true, serverOwned: result.serverOwned }));
        } catch (error) {
          if (!(error instanceof ApplicationError)) throw error;
          const status = httpStatusForError(error.code);
          const { errorCode } = error;
          console.log(JSON.stringify({ ok: false, status, errorCode }));
        }
        await once(process.stdin, 'data');
        await driver.shutdown();
        await pool.end();
      `;
      const env = {
        ...process.env,
        RACE_DATABASE: database.connectionString,
        RACE_MODEL: modelBase,
        RACE_OWNER: actor.userId,
        RACE_CONVERSATION: started.conversationId,
        RACE_RUN: started.runId,
        RACE_CHECKPOINT: waiting.waiting_checkpoint_id,
        RACE_ROOT: root,
      };
      for (let i = 0; i < 2; i++)
        children.push(
          Bun.spawn([process.execPath, '--no-env-file', '-e', source], {
            cwd: fileURLToPath(new URL('../..', import.meta.url)),
            env,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
          }),
        );
      const readers = children.map((child) => child.stdout.getReader());
      const next = async (reader: (typeof readers)[number]) => {
        const result = await reader.read();
        if (result.done) throw new Error('resume process exited before reporting');
        return JSON.parse(new TextDecoder().decode(result.value).trim());
      };
      expect(await Promise.all(readers.map(next))).toEqual([{ ready: true }, { ready: true }]);
      for (const child of children) {
        child.stdin.write('go\n');
        child.stdin.flush();
      }
      const results = await Promise.all(readers.map(next));
      expect(results.filter((result) => result.ok)).toEqual([{ ok: true, serverOwned: true }]);
      expect(results.filter((result) => !result.ok)).toEqual([
        expect.objectContaining({ ok: false, status: 409 }),
      ]);
      await resumedModel.promise;
      expect(modelCalls).toBe(3);
      expect(
        (
          await database.pool.query('SELECT count(*)::int AS n FROM run_attempts WHERE run_id=$1', [
            started.runId,
          ])
        ).rows[0].n,
      ).toBe(2);
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int AS n FROM harness_resumes WHERE run_id=$1',
            [started.runId],
          )
        ).rows[0].n,
      ).toBe(1);
      releaseModel.resolve();
      await waitUntil(
        async () =>
          (await database.pool.query('SELECT status FROM agent_runs WHERE id=$1', [started.runId]))
            .rows[0]?.status,
        (status) => status === 'done',
        diagnose,
      );
      // Let the recovery scanner run while both independent drivers are alive.
      await delay(2300);
      expect(modelCalls).toBe(5);
      expect(
        (
          await database.pool.query('SELECT count(*)::int AS n FROM run_attempts WHERE run_id=$1', [
            started.runId,
          ])
        ).rows[0].n,
      ).toBe(2);
      expect(await readFile(join(root, 'brief.txt'), 'utf8')).toBe('Updated brief.\n');
      expect(
        (
          await database.pool.query(
            "SELECT state,accepted_result->'result'->>'kind' AS kind FROM tool_invocations WHERE run_id=$1 AND tool_id='workspace_apply_replace'",
            [started.runId],
          )
        ).rows,
      ).toEqual([{ state: 'completed', kind: 'applied' }]);
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int AS n FROM document_approval_decisions WHERE target_approval_id=$1',
            [approvalId],
          )
        ).rows[0].n,
      ).toBe(1);
      for (const child of children) {
        child.stdin.write('stop\n');
        child.stdin.end();
      }
      for (const child of children) {
        const code = await child.exited;
        if (code !== 0)
          throw new Error(
            `resume process failed (${code}): ${await new Response(child.stderr).text()}`,
          );
      }
      completed = true;
    } finally {
      releaseModel.resolve();
      for (const child of children) {
        if (!completed) child.kill();
        await child.exited;
      }
      await driver.shutdown();
    }
  }, 45000);
});
