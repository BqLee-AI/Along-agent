import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GoalResultSchema } from '@along/contracts';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import { validateGoalDocuments } from '../../src/modules/conversations/goal-result.js';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { invokeTool, reserveToolInvocation } from '../../src/modules/tools/gateway.js';
import { readRunGoalDocumentEvidence } from '../../src/modules/tools/query.js';
import { configureWorkspaceRegistry } from '../../src/modules/workspaces/service.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl && process.platform === 'linux' ? describe : describe.skip;
maybe('creation collision target identity', () => {
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

  for (const rawText of [
    'Create both out/a.txt and out/b.txt with identical content.',
    'Create a report in out; if a name is taken, choose another name.',
  ]) {
    it(`does not infer a successor from equal bytes: ${rawText}`, async () => {
      const actor = await seedAdmittedSession(database.pool, {});
      const root = await mkdtemp(join(tmpdir(), 'along-create-target-'));
      roots.push(root);
      await mkdir(join(root, 'out'));
      await writeFile(join(root, 'out', 'a.txt'), 'existing');
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
        {
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
        },
        actor.userId,
        randomUUID(),
        {
          execution: 'harness',
          authorization_revision: 'delegation/1',
          raw_text: rawText,
          idempotency_key: randomUUID(),
        },
        null,
      );
      if (!started.context) throw new Error('missing context');
      const ctx = started.context;
      const call = async (toolId: string, args: unknown) => {
        const reserved = await reserveToolInvocation(database.pool, ctx, {
          callKey: randomUUID(),
          toolId,
          args,
        });
        return {
          ...reserved,
          result: await invokeTool(database.pool, ctx, { ...reserved, toolId, args }),
        };
      };
      const create = (filename: string) => ({
        workspace_id: 'docs',
        output_directory: 'out',
        filename,
        content: 'same content',
      });
      const conflict = await call('workspace_create', create('a.txt'));
      expect(conflict.result).toMatchObject({
        status: 'ok',
        result: { kind: 'create_conflict', zero_write: true },
      });
      const other = await call('workspace_create', create('b.txt'));
      expect(other.result).toMatchObject({ status: 'ok', result: { kind: 'create_applied' } });
      const read = await call('workspace_read', { workspace_id: 'docs', path: 'out/b.txt' });
      expect(read.result).toMatchObject({
        status: 'ok',
        result: { kind: 'read', content: 'same content' },
      });
      expect(await readFile(join(root, 'out', 'a.txt'), 'utf8')).toBe('existing');
      const client = await database.pool.connect();
      try {
        const documents = await readRunGoalDocumentEvidence(client, ctx);
        expect(documents.effects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              invocation_id: conflict.invocationId,
              status: 'conflict',
              superseded: false,
            }),
            expect.objectContaining({
              invocation_id: other.invocationId,
              status: 'verified',
              read_invocation_id: read.invocationId,
            }),
          ]),
        );
        const completed = GoalResultSchema.parse({
          status: 'completed',
          outcomes: [
            {
              description: 'Created b',
              status: 'achieved',
              receipt_refs: [other.invocationId, read.invocationId],
            },
          ],
          clarification: null,
          answer: 'Created b.',
        });
        expect(() => validateGoalDocuments(completed, documents)).toThrow();
        const stored = await client.query(
          `SELECT frozen_context->'documentCreate'->>'replaces_invocation_id' AS predecessor
           FROM tool_invocations WHERE invocation_id=$1`,
          [other.invocationId],
        );
        expect(stored.rows[0].predecessor).toBeNull();
        // Simulate a historical inferred edge without mutating the immutable ledger.
        const historicalClient = new Proxy(client, {
          get(target, property) {
            if (property !== 'query') return Reflect.get(target, property, target);
            return async (text: string, values: unknown[]) => {
              const result = await target.query(text, values);
              if (text.includes("tool_id IN ('workspace_replace'")) {
                result.rows = result.rows.map((row) =>
                  row.invocation_id === other.invocationId
                    ? {
                        ...row,
                        frozen_context: {
                          ...row.frozen_context,
                          documentCreate: {
                            ...row.frozen_context.documentCreate,
                            replaces_invocation_id: conflict.invocationId,
                          },
                        },
                      }
                    : row,
                );
              }
              return result;
            };
          },
        });
        const historical = await readRunGoalDocumentEvidence(historicalClient, ctx);
        expect(historical.effects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ invocation_id: conflict.invocationId, superseded: false }),
          ]),
        );
        expect(() => validateGoalDocuments(completed, historical)).toThrow();
      } finally {
        client.release();
      }
    });
  }
});
