import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import type { HarnessServices } from '../../src/agent/runtime/contracts.js';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import { configureWorkspaceRegistry } from '../../src/features/workspaces/public.js';
import { readRunGoalDocumentEvidence } from '../../src/agent/tools/query.js';
import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl && process.platform === 'linux' ? describe : describe.skip;
maybe('workspace create once permit', () => {
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
  it('freezes the grant and bytes, replays a completed slot and never dispatches an unknown slot', async () => {
    const actor = await seedAdmittedSession(database.pool, {});
    await configureTestModel(database.pool, actor.userId, 'test');
    const root = await mkdtemp(join(tmpdir(), 'along-create-once-'));
    roots.push(root);
    await mkdir(join(root, 'out'));
    await mkdir(join(root, 'out', 'nested'));
    await configureWorkspaceRegistry([
      {
        workspace_id: 'docs',
        owner_id: actor.userId,
        label: 'Docs',
        root,
        readable_paths: [],
        writable_paths: [],
        output_directories: ['out'],
      },
    ]);
    const started = await startConversationRun(
      controlledModelDeps({
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
        } satisfies HarnessServices,
      }),
      actor.userId,
      randomUUID(),
      {
        execution: 'harness',
        authorization_revision: 'delegation/1',
        raw_text: 'Create a file',
        idempotency_key: randomUUID(),
      },
      null,
    );
    if (!started.context) throw new Error('missing context');
    const ctx = started.context;
    const args = {
      workspace_id: 'docs',
      output_directory: 'out/nested',
      filename: 'a.txt',
      content: '\uFEFF中\u0000文\r\n',
    };
    const input = { callKey: 'one', toolId: 'workspace_create', args };
    const reserved = await reserveToolInvocation(database.pool, ctx, input);
    await expect(
      reserveToolInvocation(database.pool, ctx, {
        callKey: 'traversal',
        toolId: 'workspace_create',
        args: { ...args, filename: '../escape.txt' },
      }),
    ).rejects.toThrow();
    await expect(
      reserveToolInvocation(database.pool, ctx, {
        callKey: 'unfrozen',
        toolId: 'workspace_create',
        args: { ...args, output_directory: 'other' },
      }),
    ).rejects.toThrow();
    await expect(
      reserveToolInvocation(
        database.pool,
        { ...ctx, allowlist: ctx.allowlist.filter((id) => id !== 'workspace_create') },
        {
          callKey: 'old-run',
          toolId: 'workspace_create',
          args,
        },
      ),
    ).rejects.toThrow();
    const first = await invokeTool(database.pool, ctx, { ...reserved, toolId: input.toolId, args });
    expect(first).toMatchObject({
      status: 'ok',
      result: { kind: 'create_applied', path: 'out/nested/a.txt' },
    });
    expect(JSON.stringify(first)).not.toContain('file_identity');
    const createdLedger = await database.pool.query(
      'SELECT accepted_result FROM tool_invocations WHERE invocation_id=$1',
      [reserved.invocationId],
    );
    expect(typeof createdLedger.rows[0].accepted_result.file_identity).toBe('string');
    expect(await readFile(join(root, 'out', 'nested', 'a.txt'), 'utf8')).toBe(args.content);
    const replay = await invokeTool(database.pool, ctx, {
      ...reserved,
      toolId: input.toolId,
      args,
    });
    expect(replay).toMatchObject({
      status: 'ok',
      replayed: true,
      result: { kind: 'create_applied' },
    });
    await expect(
      reserveToolInvocation(database.pool, ctx, {
        ...input,
        args: { ...args, content: 'changed' },
      }),
    ).rejects.toThrow();
    const readArgs = { workspace_id: 'docs', path: 'out/nested/a.txt' };
    const read = await reserveToolInvocation(database.pool, ctx, {
      callKey: 'read',
      toolId: 'workspace_read',
      args: readArgs,
    });
    expect(
      await invokeTool(database.pool, ctx, { ...read, toolId: 'workspace_read', args: readArgs }),
    ).toMatchObject({ status: 'ok', result: { kind: 'read', content: args.content } });
    expect(
      await invokeTool(database.pool, ctx, { ...read, toolId: 'workspace_read', args: readArgs }),
    ).toMatchObject({
      status: 'ok',
      replayed: true,
      result: { kind: 'read', content: args.content },
    });
    const stored = await database.pool.query(
      'SELECT accepted_result FROM tool_invocations WHERE invocation_id=$1',
      [read.invocationId],
    );
    expect(stored.rows[0].accepted_result.encoding).toBe('json-base64/1');
    expect(
      JSON.parse(Buffer.from(stored.rows[0].accepted_result.data, 'base64').toString('utf8')).result
        .content,
    ).toBe(args.content);
    const pageArgs = {
      source_invocation_id: read.invocationId,
      field: 'content',
      offset: 0,
      limit: 128,
    };
    const page = await reserveToolInvocation(database.pool, ctx, {
      callKey: 'page',
      toolId: 'read_run_observation',
      args: pageArgs,
    });
    expect(
      await invokeTool(database.pool, ctx, {
        ...page,
        toolId: 'read_run_observation',
        args: pageArgs,
      }),
    ).toMatchObject({ status: 'ok', result: { kind: 'context_slice', content: args.content } });
    expect(
      await invokeTool(database.pool, ctx, {
        ...page,
        toolId: 'read_run_observation',
        args: pageArgs,
      }),
    ).toMatchObject({
      status: 'ok',
      replayed: true,
      result: { kind: 'context_slice', content: args.content },
    });
    const client = await database.pool.connect();
    try {
      expect((await readRunGoalDocumentEvidence(client, ctx)).effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invocation_id: reserved.invocationId,
            status: 'verified',
            read_invocation_id: read.invocationId,
          }),
        ]),
      );
    } finally {
      client.release();
    }
    const unknownArgs = { ...args, filename: 'unknown.txt' };
    const unknown = await reserveToolInvocation(database.pool, ctx, {
      callKey: 'unknown',
      toolId: input.toolId,
      args: unknownArgs,
    });
    await database.pool.query(`
      CREATE FUNCTION fail_create_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.state = 'unknown' AND NEW.state = 'completed' THEN
          RAISE EXCEPTION 'injected acceptance failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_create_acceptance BEFORE UPDATE ON tool_invocations
        FOR EACH ROW EXECUTE FUNCTION fail_create_acceptance();
    `);
    const lost = await invokeTool(database.pool, ctx, {
      ...unknown,
      toolId: input.toolId,
      args: unknownArgs,
    });
    expect(lost).toMatchObject({ status: 'unknown' });
    expect(await readFile(join(root, 'out', 'nested', 'unknown.txt'), 'utf8')).toBe(args.content);
    await database.pool.query('DROP TRIGGER fail_create_acceptance ON tool_invocations');
    expect(
      await invokeTool(database.pool, ctx, { ...unknown, toolId: input.toolId, args: unknownArgs }),
    ).toMatchObject({ status: 'unknown', replayed: true });
    await expect(
      reserveToolInvocation(database.pool, ctx, {
        callKey: 'after-unknown',
        toolId: input.toolId,
        args: { ...args, filename: 'other.txt' },
      }),
    ).rejects.toThrow();
  });
});
