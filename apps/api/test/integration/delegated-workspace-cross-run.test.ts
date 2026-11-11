import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { invokeTool, reserveToolInvocation } from '../../src/modules/tools/gateway.js';
import { configureWorkspaceRegistry } from '../../src/modules/workspaces/service.js';
import { configureTestModel } from '../helpers/model-selection.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl && process.platform === 'linux' ? describe : describe.skip;
maybe('cross-run created workspace files', () => {
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

  it('only exposes accepted creations to the same owner under current output authority and unchanged identities', async () => {
    const actor = await seedAdmittedSession(database.pool, {});
    const other = await seedAdmittedSession(database.pool, {});
    await configureTestModel(database.pool, actor.userId, 'test');
    await configureTestModel(database.pool, other.userId, 'test');
    const root = await mkdtemp(join(tmpdir(), 'along-cross-run-create-'));
    roots.push(root);
    await mkdir(join(root, 'output'));
    await mkdir(join(root, 'other'));
    await writeFile(join(root, 'output', 'existing.txt'), 'private existing');
    const registration = (ownerId: string, outputDirectories: string[]) => ({
      workspace_id: 'docs',
      owner_id: ownerId,
      label: 'Docs',
      root,
      readable_paths: [],
      writable_paths: [],
      output_directories: outputDirectories,
    });
    const deps = {
      pool: database.pool,
      timeContext: loadTimeContext('fixture-v1'),
      harness: {
        binaryPath: '/unused',
        maxIterations: 24,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({ completionCap: 512, model: 'test' }),
        model: async function* () {
          throw new Error('model not used');
        },
      },
    };
    const start = async (ownerId: string, legacy = false) => {
      const started = await startConversationRun(
        deps,
        ownerId,
        randomUUID(),
        {
          execution: 'harness',
          authorization_revision: 'delegation/1',
          raw_text: 'Work with outputs',
          idempotency_key: randomUUID(),
        },
        null,
      );
      if (!started.context) throw new Error('missing context');
      let ctx = started.context;
      if (legacy) {
        const runId = randomUUID();
        const attemptId = randomUUID();
        await database.pool.query(
          `WITH legacy AS (
             INSERT INTO agent_runs(id,owner_id,conversation_id,agent_revision,mode,status,
               budget_max_iterations,budget_max_tokens,execution,tools_allowlist,frozen_context,input_message_id)
             SELECT $2,owner_id,conversation_id,agent_revision,mode,'running',
               budget_max_iterations,budget_max_tokens,execution,tools_allowlist,
               frozen_context-'createdArtifactReadRevision',input_message_id FROM agent_runs WHERE id=$1
             RETURNING id,owner_id
           ) INSERT INTO run_attempts(id,owner_id,run_id,attempt_no,status)
             SELECT $3,owner_id,id,1,'running' FROM legacy`,
          [ctx.runId, runId, attemptId],
        );
        await database.pool.query(
          `INSERT INTO run_context_policies(run_id,owner_id,policy,policy_hash)
           SELECT $2,owner_id,policy,policy_hash FROM run_context_policies WHERE run_id=$1`,
          [ctx.runId, runId],
        );
        ctx = { ...ctx, runId, attemptId };
      }
      return async (toolId: string, args: unknown) => {
        const reserved = await reserveToolInvocation(database.pool, ctx, {
          callKey: randomUUID(),
          toolId,
          args,
        });
        return invokeTool(database.pool, ctx, { ...reserved, toolId, args });
      };
    };
    const read = { workspace_id: 'docs', path: 'output/created.txt' };
    await configureWorkspaceRegistry([registration(actor.userId, ['output'])]);
    const older = await start(actor.userId);
    const first = await start(actor.userId);
    const created = await first('workspace_create', {
      workspace_id: 'docs',
      output_directory: 'output',
      filename: 'created.txt',
      content: 'created marker',
    });
    expect(created).toMatchObject({ status: 'ok', result: { kind: 'create_applied' } });

    // A changed registration with the same root and output directory remains eligible.
    expect(await older('workspace_read', read)).toMatchObject({ status: 'denied' });
    const legacy = await start(actor.userId, true);
    expect(
      await legacy('workspace_create', {
        workspace_id: 'docs',
        output_directory: 'output',
        filename: 'legacy.txt',
        content: 'legacy',
      }),
    ).toMatchObject({ status: 'ok', result: { kind: 'create_applied' } });
    expect(
      await legacy('workspace_read', { workspace_id: 'docs', path: 'output/legacy.txt' }),
    ).toMatchObject({
      status: 'ok',
      result: { kind: 'read', content: 'legacy' },
    });
    expect(await legacy('workspace_read', read)).toMatchObject({ status: 'denied' });
    await configureWorkspaceRegistry([registration(actor.userId, ['output', 'other'])]);
    const second = await start(actor.userId);
    expect(await second('workspace_read', read)).toMatchObject({
      status: 'ok',
      result: { kind: 'read', content: 'created marker' },
    });
    expect(await second('workspace_list', { workspace_id: 'docs', path: 'output' })).toMatchObject({
      status: 'ok',
      result: {
        kind: 'list',
        entries: expect.arrayContaining([
          expect.objectContaining({ path: read.path, kind: 'file' }),
        ]),
      },
    });
    expect(
      await second('workspace_grep', { workspace_id: 'docs', path: 'output', literal: 'marker' }),
    ).toMatchObject({
      status: 'ok',
      result: {
        kind: 'search',
        matches: expect.arrayContaining([expect.objectContaining({ path: read.path })]),
      },
    });
    expect(
      await second('workspace_read', { workspace_id: 'docs', path: 'output/existing.txt' }),
    ).toMatchObject({ status: 'denied' });

    await configureWorkspaceRegistry([registration(other.userId, ['output'])]);
    const otherRun = await start(other.userId);
    expect(await otherRun('workspace_read', read)).toMatchObject({ status: 'denied' });

    await configureWorkspaceRegistry([registration(actor.userId, ['other'])]);
    const revoked = await start(actor.userId);
    expect(await revoked('workspace_read', read)).toMatchObject({ status: 'denied' });

    await configureWorkspaceRegistry([registration(actor.userId, ['output'])]);
    const changed = await start(actor.userId);
    await writeFile(join(root, 'output', 'created.txt'), 'changed content');
    const versionChanged = await changed('workspace_read', read);
    expect(versionChanged.status === 'ok' && versionChanged.result.kind === 'read').toBe(false);
    await rename(join(root, 'output', 'created.txt'), join(root, 'output', 'changed.txt'));
    await writeFile(join(root, 'output', 'created.txt'), 'created marker');
    const replaced = await start(actor.userId);
    const identityChanged = await replaced('workspace_read', read);
    expect(identityChanged.status === 'ok' && identityChanged.result.kind === 'read').toBe(false);

    await rename(join(root, 'output'), join(root, 'old-output'));
    await mkdir(join(root, 'output'));
    await writeFile(join(root, 'output', 'created.txt'), 'created marker');
    await configureWorkspaceRegistry([registration(actor.userId, ['output'])]);
    const directoryChanged = await start(actor.userId);
    const directoryRead = await directoryChanged('workspace_read', read);
    expect(directoryRead.status === 'ok' && directoryRead.result.kind === 'read').toBe(false);
    // Construct corrupt historical evidence at insertion, without mutating an accepted ledger row.
    const corruptId = randomUUID();
    await database.pool.query(
      `INSERT INTO tool_invocations
         (invocation_id,owner_id,conversation_id,run_id,call_key,first_attempt_id,first_request_id,
          tool_id,args_hash,args_bytes,execution_kind,frozen_context,state,outcome_kind,result_version,
          accepted_result,approval_id,accepted_attempt_id,accepted_request_id,accepted_at,evidence_ref)
       SELECT $2::uuid,owner_id,conversation_id,run_id,$2::uuid::text,first_attempt_id,first_request_id,
          tool_id,args_hash,args_bytes,execution_kind,frozen_context,state,outcome_kind,result_version,
          jsonb_set(jsonb_set(accepted_result,'{result,invocation_id}',to_jsonb($2::uuid::text)),
            '{result,version}',to_jsonb($3::text)),
          approval_id,accepted_attempt_id,accepted_request_id,clock_timestamp(),evidence_ref
       FROM tool_invocations WHERE invocation_id=$1`,
      [created.invocationId, corruptId, '0'.repeat(64)],
    );
    const corruptEvidence = await start(actor.userId);
    await expect(corruptEvidence('workspace_read', read)).rejects.toThrow();
  });
});
