import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmDocumentApproval } from '../../src/agent/operations/document-decision.js';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import type { HarnessServices } from '../../src/agent/runtime/contracts.js';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import { readRunGoalDocumentEvidence } from '../../src/agent/tools/query.js';
import { configureWorkspaceRegistry } from '../../src/features/workspaces/public.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl && process.platform === 'linux' ? describe : describe.skip;
maybe('delegated workspace gateway', () => {
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
  it('uses real MCP, freezes the exact edit, and requires a fresh accepted read to verify', async () => {
    const actor = await seedAdmittedSession(database.pool, {});
    await configureTestModel(database.pool, actor.userId, 'test');
    const root = await mkdtemp(join(tmpdir(), 'along-delegated-gateway-'));
    roots.push(root);
    await writeFile(join(root, 'memo.txt'), '\uFEFFold 中文\r\n');
    await configureWorkspaceRegistry([
      {
        workspace_id: 'docs',
        owner_id: actor.userId,
        label: 'Docs',
        root,
        readable_paths: ['memo.txt'],
        writable_paths: ['memo.txt'],
      },
    ]);
    const deps = {
      pool: database.pool,
      timeContext: loadTimeContext('fixture-v1'),
      harness: {
        binaryPath: '/unused',
        maxIterations: 24,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({ completionCap: 512, model: 'test' }),
        // oxlint-disable-next-line require-yield -- Failure-only provider intentionally emits no events.
        model: async function* () {
          throw new Error('model not used');
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
    if (!started.context) throw new Error('missing context');
    const ctx = started.context;
    let slot = 0;
    const call = async (toolId: string, args: unknown) => {
      const reserved = await reserveToolInvocation(database.pool, ctx, {
        callKey: `test/${++slot}`,
        toolId,
        args,
      });
      return invokeTool(database.pool, ctx, { ...reserved, toolId, args });
    };
    const read = await call('workspace_read', { workspace_id: 'docs', path: 'memo.txt' });
    expect(read).toMatchObject({
      status: 'ok',
      result: { kind: 'read', workspace_id: 'docs', content: '\uFEFFold 中文\r\n' },
    });
    const edit = await call('workspace_replace', {
      read_invocation_id: read.invocationId,
      change: { kind: 'literal', old_text: 'old', new_text: 'new' },
    });
    expect(edit).toMatchObject({
      status: 'ok',
      result: { kind: 'edit_applied', workspace_id: 'docs' },
    });
    expect(await readFile(join(root, 'memo.txt'), 'utf8')).toBe('\uFEFFnew 中文\r\n');
    const client = await database.pool.connect();
    try {
      expect((await readRunGoalDocumentEvidence(client, ctx)).effects).toMatchObject([
        { invocation_id: edit.invocationId, status: 'applied' },
      ]);
      const fresh = await call('workspace_read', { workspace_id: 'docs', path: 'memo.txt' });
      expect((await readRunGoalDocumentEvidence(client, ctx)).effects).toMatchObject([
        {
          invocation_id: edit.invocationId,
          status: 'verified',
          read_invocation_id: fresh.invocationId,
        },
      ]);
      expect(
        (
          await client.query('SELECT count(*)::int AS n FROM document_approvals WHERE run_id=$1', [
            ctx.runId,
          ])
        ).rows[0].n,
      ).toBe(0);
      const propose = async (readInvocationId: string) => {
        const result = await call('workspace_propose_replace', {
          read_invocation_id: readInvocationId,
          change: { kind: 'literal', old_text: 'new', new_text: 'final' },
        });
        if (result.status !== 'ok' || result.result.kind !== 'document_approval')
          throw new Error('expected document approval');
        const receipt = result.result.approval;
        await confirmDocumentApproval({ pool: database.pool }, ctx.ownerId, receipt.approval_id, {
          presentation_hash: receipt.presentation_hash,
          seen_content: receipt.preview.body,
          idempotency_key: randomUUID(),
        });
        return receipt;
      };
      const first = await propose(fresh.invocationId);
      await rm(join(root, 'memo.txt'));
      const conflict = await call('workspace_apply_replace', { approval_id: first.approval_id });
      expect(conflict).toMatchObject({
        status: 'ok',
        result: { kind: 'conflict', reason: 'not_found', zero_write: true },
      });
      await writeFile(join(root, 'memo.txt'), '\uFEFFnew 中文\r\n');
      const restored = await call('workspace_read', { workspace_id: 'docs', path: 'memo.txt' });
      const second = await propose(restored.invocationId);
      const applied = await call('workspace_apply_replace', { approval_id: second.approval_id });
      expect(applied).toMatchObject({ status: 'ok', result: { kind: 'applied' } });
      await call('workspace_read', { workspace_id: 'docs', path: 'memo.txt' });
      expect((await readRunGoalDocumentEvidence(client, ctx)).effects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invocation_id: conflict.invocationId,
            status: 'conflict',
            superseded: true,
          }),
          expect.objectContaining({ invocation_id: applied.invocationId, status: 'verified' }),
        ]),
      );
    } finally {
      client.release();
    }
  });
  it('lists only authorized output paths without hiding an exclusive-create conflict', async () => {
    const actor = await seedAdmittedSession(database.pool, {});
    await configureTestModel(database.pool, actor.userId, 'test');
    const root = await mkdtemp(join(tmpdir(), 'along-output-list-'));
    roots.push(root);
    await mkdir(join(root, 'output'));
    await writeFile(join(root, 'output', 'private.txt'), 'not registered');
    await configureWorkspaceRegistry([
      {
        workspace_id: 'docs',
        owner_id: actor.userId,
        label: 'Docs',
        root,
        readable_paths: [],
        writable_paths: [],
        output_directories: ['output'],
      },
    ]);
    const deps = {
      pool: database.pool,
      timeContext: loadTimeContext('fixture-v1'),
      harness: {
        binaryPath: '/unused',
        maxIterations: 24,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({ completionCap: 512, model: 'test' }),
        // oxlint-disable-next-line require-yield -- Failure-only provider intentionally emits no events.
        model: async function* () {
          throw new Error('model not used');
        },
      },
    };
    const start = async () => {
      const run = await startConversationRun(
        deps,
        actor.userId,
        randomUUID(),
        {
          execution: 'harness',
          authorization_revision: 'delegation/1',
          raw_text: 'List the output directory and create a file.',
          idempotency_key: randomUUID(),
        },
        null,
      );
      if (!run.context) throw new Error('missing context');
      const ctx = run.context;
      let slot = 0;
      return async (toolId: string, args: unknown) => {
        const reserved = await reserveToolInvocation(database.pool, ctx, {
          callKey: `output-list/${++slot}`,
          toolId,
          args,
        });
        return invokeTool(database.pool, ctx, { ...reserved, toolId, args });
      };
    };
    const call = await start();
    const listing = await call('workspace_list', { workspace_id: 'docs', path: 'output' });
    expect(listing).toMatchObject({
      status: 'ok',
      result: {
        kind: 'list',
        path: 'output',
        visibility: 'authorized_paths_only',
        entries: [],
        failures: [],
      },
    });
    expect(JSON.stringify(listing)).not.toContain('private.txt');
    const conflict = await call('workspace_create', {
      workspace_id: 'docs',
      output_directory: 'output',
      filename: 'private.txt',
      content: 'replacement',
    });
    expect(conflict).toMatchObject({
      status: 'ok',
      result: { kind: 'create_conflict', zero_write: true },
    });
    expect(await readFile(join(root, 'output', 'private.txt'), 'utf8')).toBe('not registered');

    // A denied read hard-stops its run, so it must not share the conflict run.
    const readCall = await start();
    expect(
      await readCall('workspace_read', { workspace_id: 'docs', path: 'output/private.txt' }),
    ).toMatchObject({ status: 'denied' });
  });
  it.each(['撞名改名验收完成。', '撞名改名验收完成。\n', '\uFEFF中文😀\r\n'])(
    'preserves submitted bytes after collision: %j',
    async (content) => {
      const actor = await seedAdmittedSession(database.pool, {});
      await configureTestModel(database.pool, actor.userId, 'test');
      const root = await mkdtemp(join(tmpdir(), 'along-create-projection-'));
      roots.push(root);
      await mkdir(join(root, 'output'));
      await writeFile(join(root, 'output', 'occupied.txt'), 'existing');
      await writeFile(join(root, 'output', 'alias.txt'), content);
      await writeFile(join(root, 'output', 'private.txt'), 'not registered');
      await configureWorkspaceRegistry([
        {
          workspace_id: 'docs',
          owner_id: actor.userId,
          label: 'Docs',
          root,
          readable_paths: ['output/alias.txt', 'output/occupied.txt'],
          writable_paths: [],
          output_directories: ['output'],
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
            // oxlint-disable-next-line require-yield -- Failure-only provider intentionally emits no events.
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
          raw_text: 'Create an output file, using an alias if occupied.',
          idempotency_key: randomUUID(),
        },
        null,
      );
      if (!started.context) throw new Error('missing context');
      const ctx = started.context;
      let slot = 0;
      const call = async (toolId: string, args: unknown) => {
        const reserved = await reserveToolInvocation(database.pool, ctx, {
          callKey: `create/${++slot}`,
          toolId,
          args,
        });
        return invokeTool(database.pool, ctx, { ...reserved, toolId, args });
      };
      const oldRead = await call('workspace_read', {
        workspace_id: 'docs',
        path: 'output/alias.txt',
      });
      const listing = await call('workspace_list', { workspace_id: 'docs', path: 'output' });
      if (listing.status !== 'ok' || listing.result.kind !== 'list') {
        throw new Error('expected a workspace listing');
      }
      expect(listing.result).toMatchObject({ visibility: 'authorized_paths_only' });
      expect(listing.result.entries).toEqual([
        { path: 'output/alias.txt', kind: 'file' },
        { path: 'output/occupied.txt', kind: 'file' },
      ]);
      expect(JSON.stringify(listing)).not.toContain('private.txt');
      const search = await call('workspace_grep', {
        workspace_id: 'docs',
        path: 'output',
        literal: 'existing',
      });
      expect(search).toMatchObject({
        status: 'ok',
        result: {
          kind: 'search',
          matches: expect.arrayContaining([
            expect.objectContaining({ path: 'output/occupied.txt' }),
          ]),
        },
      });
      expect(oldRead).toMatchObject({
        status: 'ok',
        result: { kind: 'read', content },
      });
      await rm(join(root, 'output', 'alias.txt'));
      const conflict = await call('workspace_create', {
        workspace_id: 'docs',
        output_directory: 'output',
        filename: 'occupied.txt',
        content,
      });
      expect(conflict).toMatchObject({
        status: 'ok',
        result: { kind: 'create_conflict', zero_write: true },
      });
      expect(await readFile(join(root, 'output', 'occupied.txt'), 'utf8')).toBe('existing');
      const created = await call('workspace_create', {
        workspace_id: 'docs',
        output_directory: 'output',
        filename: 'alias.txt',
        content,
      });
      expect(created).toMatchObject({ status: 'ok', result: { kind: 'create_applied' } });
      expect(await readFile(join(root, 'output', 'alias.txt'))).toEqual(
        Buffer.from(content, 'utf8'),
      );
      const page = await call('read_run_observation', {
        source_invocation_id: oldRead.invocationId,
        field: 'content',
        offset: 0,
        limit: 100,
      });
      expect(page).toMatchObject({
        status: 'ok',
        result: { kind: 'context_slice', content },
      });
      const client = await database.pool.connect();
      try {
        expect((await readRunGoalDocumentEvidence(client, ctx)).effects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              invocation_id: conflict.invocationId,
              status: 'conflict',
              superseded: false,
              operation: 'create',
            }),
            expect.objectContaining({
              invocation_id: created.invocationId,
              status: 'applied',
              read_invocation_id: null,
            }),
          ]),
        );
        const fresh = await call('workspace_read', {
          workspace_id: 'docs',
          path: 'output/alias.txt',
        });
        expect(fresh).toMatchObject({ status: 'ok', result: { kind: 'read', content } });
        expect(await readFile(join(root, 'output', 'alias.txt'))).toEqual(
          Buffer.from(content, 'utf8'),
        );
        expect((await readRunGoalDocumentEvidence(client, ctx)).effects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              invocation_id: conflict.invocationId,
              status: 'conflict',
              superseded: false,
            }),
            expect.objectContaining({
              invocation_id: created.invocationId,
              status: 'verified',
              read_invocation_id: fresh.invocationId,
            }),
          ]),
        );
        const nulText = 'marker\u0000中文😀';
        const nulCreate = await call('workspace_create', {
          workspace_id: 'docs',
          output_directory: 'output',
          filename: 'null-bytes.txt',
          content: nulText,
        });
        expect(nulCreate).toMatchObject({ status: 'ok', result: { kind: 'create_applied' } });
        expect(await readFile(join(root, 'output', 'null-bytes.txt'), 'utf8')).toBe(nulText);
        const nulRead = await call('workspace_read', {
          workspace_id: 'docs',
          path: 'output/null-bytes.txt',
        });
        expect(nulRead).toMatchObject({ status: 'ok', result: { kind: 'read', content: nulText } });
        const nulPage = await call('read_run_observation', {
          source_invocation_id: nulRead.invocationId,
          field: 'content',
          offset: 0,
          limit: 100,
        });
        expect(nulPage).toMatchObject({
          status: 'ok',
          result: { kind: 'context_slice', content: nulText },
        });
        const nulSearch = await call('workspace_grep', {
          workspace_id: 'docs',
          path: 'output',
          literal: 'marker',
        });
        expect(nulSearch).toMatchObject({
          status: 'ok',
          result: {
            kind: 'search',
            matches: expect.arrayContaining([
              expect.objectContaining({ path: 'output/null-bytes.txt', text: nulText }),
            ]),
          },
        });
        const matchPage = await call('read_run_observation', {
          source_invocation_id: nulSearch.invocationId,
          field: 'matches',
          offset: 0,
          limit: 100,
        });
        expect(matchPage).toMatchObject({
          status: 'ok',
          result: {
            kind: 'context_slice',
            items: expect.arrayContaining([
              expect.objectContaining({ path: 'output/null-bytes.txt', text: nulText }),
            ]),
          },
        });
        expect((await readRunGoalDocumentEvidence(client, ctx)).effects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              invocation_id: nulCreate.invocationId,
              status: 'verified',
              read_invocation_id: nulRead.invocationId,
            }),
          ]),
        );
      } finally {
        client.release();
      }
    },
  );
});
