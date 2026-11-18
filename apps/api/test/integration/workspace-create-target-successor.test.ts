import { configureTestModel, controlledModelDeps } from '../helpers/model-selection.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GoalResultSchema } from '@along/contracts';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextPolicy } from '../../src/features/conversations/public.js';
import type { HarnessServices } from '../../src/agent/runtime/contracts.js';
import {
  validateGoalDocuments,
  validateGoalResult,
} from '../../src/agent/operations/goal-result.js';
import { startConversationRun } from '../../src/agent/operations/start.js';
import { loadTimeContext } from '../../src/features/time/context.js';
import { invokeTool, reserveToolInvocation } from '../../src/agent/tools/gateway.js';
import {
  readRunGoalDocumentEvidence,
  validateCreateResolutionEvidence,
} from '../../src/agent/tools/query.js';
import { configureWorkspaceRegistry } from '../../src/features/workspaces/public.js';
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
    'Create a report in out; if a name is taken, choose another name and revise the draft.',
  ]) {
    it(`requires explicit, fact-checked collision recovery: ${rawText}`, async () => {
      const actor = await seedAdmittedSession(database.pool, {});
      await configureTestModel(database.pool, actor.userId, 'test');
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
        content:
          rawText.includes('revise the draft') && filename === 'b.txt'
            ? 'revised content'
            : 'same content',
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
        result: {
          kind: 'read',
          content: rawText.includes('revise the draft') ? 'revised content' : 'same content',
        },
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
        if (rawText.includes('both out/a.txt')) {
          const partial = {
            ...completed,
            status: 'partial' as const,
            outcomes: [
              completed.outcomes[0]!,
              {
                description: 'Create a',
                status: 'not_done' as const,
                receipt_refs: [conflict.invocationId],
              },
            ],
            answer: 'Created b; a already exists and was not overwritten.',
          };
          expect(await validateGoalResult(client, ctx, partial)).toEqual(partial);
        }
        if (rawText.includes('choose another name')) {
          const run = await client.query<{ input_message_id: string }>(
            'SELECT input_message_id FROM agent_runs WHERE id=$1',
            [ctx.runId],
          );
          const resolution = {
            source_message_id: run.rows[0]!.input_message_id,
            source_quote: rawText,
            zero_write_invocation_ids: [conflict.invocationId],
            created_invocation_id: other.invocationId,
            read_invocation_id: read.invocationId,
          };
          const resolved = {
            ...completed,
            outcomes: [
              {
                ...completed.outcomes[0]!,
                receipt_refs: [conflict.invocationId, other.invocationId, read.invocationId],
                create_resolution: resolution,
              },
            ],
          };
          expect(await validateGoalResult(client, ctx, resolved)).toEqual(resolved);
          if (rawText.includes('revise the draft')) {
            const oldRevisionClient = new Proxy(client, {
              get(target, property) {
                if (property !== 'query') return Reflect.get(target, property, target);
                return async (text: string, values: unknown[]) => {
                  const result = await target.query(text, values);
                  if (text.includes('AS revision') && text.includes('original_id'))
                    result.rows = result.rows.map((row) => ({
                      ...row,
                      revision: 'create-resolution/1',
                    }));
                  if (text.includes('AS resolution_revision'))
                    result.rows = result.rows.map((row) => ({
                      ...row,
                      resolution_revision: 'create-resolution/1',
                    }));
                  return result;
                };
              },
            });
            await expect(validateGoalResult(oldRevisionClient, ctx, resolved)).rejects.toThrow(
              'invalid create resolution predecessor',
            );
          }
          for (const patch of [
            { source_message_id: randomUUID() },
            { source_quote: 'not in the user message' },
            { zero_write_invocation_ids: [randomUUID()] },
            { created_invocation_id: conflict.invocationId },
            { read_invocation_id: conflict.invocationId },
          ]) {
            const bad = {
              ...resolved,
              outcomes: [
                {
                  ...resolved.outcomes[0]!,
                  create_resolution: { ...resolution, ...patch },
                },
              ],
            };
            await expect(validateGoalResult(client, ctx, bad)).rejects.toThrow();
          }
          const legacyClient = new Proxy(client, {
            get(target, property) {
              if (property !== 'query') return Reflect.get(target, property, target);
              return async (text: string, values: unknown[]) => {
                const result = await target.query(text, values);
                if (text.includes('AS revision') && text.includes('original_id'))
                  result.rows = result.rows.map((row) => ({ ...row, revision: null }));
                return result;
              };
            },
          });
          await expect(validateGoalResult(legacyClient, ctx, resolved)).rejects.toThrow();
          for (const scenario of ['unknown', 'old-read']) {
            const alteredClient = new Proxy(client, {
              get(target, property) {
                if (property !== 'query') return Reflect.get(target, property, target);
                return async (text: string, values: unknown[]) => {
                  const result = await target.query(text, values);
                  if (
                    scenario === 'unknown' &&
                    text.includes("tool_id='workspace_create' AND invocation_id=ANY")
                  )
                    result.rows = result.rows.map((row) =>
                      row.invocation_id === conflict.invocationId
                        ? { ...row, state: 'unknown' }
                        : row,
                    );
                  if (
                    scenario === 'old-read' &&
                    text.includes("tool_id IN ('workspace_read','workspace_apply_replace')")
                  )
                    result.rows = result.rows.map((row) =>
                      row.invocation_id === read.invocationId
                        ? { ...row, created_at: '2000-01-01T00:00:00.000000Z' }
                        : row,
                    );
                  return result;
                };
              },
            });
            await expect(validateGoalResult(alteredClient, ctx, resolved)).rejects.toThrow();
          }
          const after = await readRunGoalDocumentEvidence(client, ctx);
          expect(
            after.effects.find((item) => item.invocation_id === conflict.invocationId),
          ).toMatchObject({ status: 'conflict', superseded: false });
        }
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
        if (rawText.includes('choose another name')) {
          await writeFile(join(root, 'out', 'c.txt'), 'pre-existing');
          const sameConflict = await call('workspace_create', create('c.txt'));
          expect(sameConflict.result).toMatchObject({
            status: 'ok',
            result: { kind: 'create_conflict', zero_write: true },
          });
          await rm(join(root, 'out', 'c.txt'));
          const sameCreate = await call('workspace_create', create('c.txt'));
          expect(sameCreate.result).toMatchObject({
            status: 'ok',
            result: { kind: 'create_applied' },
          });
          const sameRead = await call('workspace_read', {
            workspace_id: 'docs',
            path: 'out/c.txt',
          });
          const current = await readRunGoalDocumentEvidence(client, ctx);
          await expect(
            validateCreateResolutionEvidence(
              client,
              ctx,
              {
                zero_write_invocation_ids: [sameConflict.invocationId],
                created_invocation_id: sameCreate.invocationId,
                read_invocation_id: sameRead.invocationId,
              },
              current,
            ),
          ).rejects.toThrow('invalid create resolution predecessor');
        }
      } finally {
        client.release();
      }
    });
  }
});
