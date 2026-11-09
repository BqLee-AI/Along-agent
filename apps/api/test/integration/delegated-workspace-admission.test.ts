import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceGrant } from '@along/contracts';
import { createContextPolicy } from '../../src/modules/conversations/context-policy.js';
import type { ConversationDeps } from '../../src/modules/conversations/contracts.js';
import {
  cancelConversationRun,
  getRunView,
} from '../../src/modules/conversations/harness-authority.js';
import { startConversationRun } from '../../src/modules/conversations/service.js';
import { loadTimeContext } from '../../src/modules/time/context.js';
import { DELEGATION_TOOL_IDS } from '../../src/modules/tools/contracts.js';
import {
  configureWorkspaceRegistry,
  resolveFrozenWorkspaceGrant,
} from '../../src/modules/workspaces/service.js';
import {
  createIntegrationDatabase,
  databaseUrl,
  seedAdmittedSession,
  type IntegrationDatabase,
} from './setup.js';

const maybe = databaseUrl ? describe : describe.skip;
const body = {
  execution: 'harness',
  authorization_revision: 'delegation/1',
  raw_text: 'Find my managed documents.',
};

maybe('delegated conversation workspace admission against PostgreSQL', () => {
  let database: IntegrationDatabase;
  let deps: ConversationDeps;
  const directories: string[] = [];

  beforeAll(async () => {
    database = await createIntegrationDatabase();
    deps = {
      pool: database.pool,
      timeContext: loadTimeContext('fixture-v1'),
      harness: {
        binaryPath: process.env.HARNESS_BINARY ?? '/app/harness/bin/along-harness',
        maxIterations: 8,
        maxTokens: 8000,
        contextPolicy: createContextPolicy({ completionCap: 512, model: 'admission-test-model' }),
        model: async function* () {
          yield {
            type: 'complete',
            reply: { message: { content: 'answer', tool_calls: [] }, usage: null },
          };
        },
      },
    };
  });
  afterEach(async () => {
    await configureWorkspaceRegistry([]);
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });
  afterAll(async () => {
    await database?.close();
  });

  async function registration(ownerId: string, id: string, writable = true) {
    const root = await mkdtemp(join(tmpdir(), 'along-admission-workspace-'));
    directories.push(root);
    return {
      workspace_id: id,
      label: `Workspace ${id}`,
      owner_id: ownerId,
      root,
      readable_paths: ['memo.txt'],
      writable_paths: writable ? ['memo.txt'] : [],
    };
  }
  async function start(ownerId: string, input: unknown = body, key: string | null = null) {
    return startConversationRun(deps, ownerId, randomUUID(), input, key);
  }
  async function stored(runId: string) {
    const result = await database.pool.query<{
      frozen_context: {
        workspaceGrants: WorkspaceGrant[];
        trustedExecutionContext: { workspaces: Array<{ workspace_id: string }> };
      };
      tools_allowlist: string[];
    }>('SELECT frozen_context, tools_allowlist FROM agent_runs WHERE id=$1', [runId]);
    if (!result.rows[0]) throw new Error('admitted run missing');
    return result.rows[0];
  }

  it('freezes every registration owned by the caller in stable order and exposes only summaries', async () => {
    const owner = await seedAdmittedSession(database.pool);
    const other = await seedAdmittedSession(database.pool);
    const z = await registration(owner.userId, 'zeta');
    const a = await registration(owner.userId, 'alpha', false);
    const foreign = await registration(other.userId, 'foreign');
    await configureWorkspaceRegistry([z, foreign, a]);
    const run = await start(owner.userId);
    const row = await stored(run.runId);
    expect(row.frozen_context.workspaceGrants.map((item) => item.workspace_id)).toEqual([
      'alpha',
      'zeta',
    ]);
    expect(
      row.frozen_context.trustedExecutionContext.workspaces.map((item) => item.workspace_id),
    ).toEqual(['alpha', 'zeta']);
    expect(row.tools_allowlist).toContain('workspace_read');
    expect(row.tools_allowlist).toContain('workspace_replace');
    const view = await getRunView(deps, owner.userId, run.conversationId, run.runId);
    expect(JSON.stringify(view)).not.toContain(z.root);
    expect(JSON.stringify(view)).not.toContain('registration_digest');
    expect(JSON.stringify(view)).not.toContain('foreign');
  });

  it('admits an empty collection without giving workspace tools or blocking other capabilities', async () => {
    const owner = await seedAdmittedSession(database.pool);
    await configureWorkspaceRegistry([]);
    const run = await start(owner.userId);
    const row = await stored(run.runId);
    expect(row.frozen_context.workspaceGrants).toEqual([]);
    expect(row.frozen_context.trustedExecutionContext.workspaces).toEqual([]);
    expect(row.tools_allowlist).toEqual([...DELEGATION_TOOL_IDS]);
    expect(row.tools_allowlist).not.toContain('workspace_read');
  });

  it('canonicalizes an explicit subset for idempotent replay and rejects changed selections', async () => {
    const owner = await seedAdmittedSession(database.pool);
    const a = await registration(owner.userId, 'alpha');
    const b = await registration(owner.userId, 'beta');
    const c = await registration(owner.userId, 'charlie');
    await configureWorkspaceRegistry([c, b, a]);
    const key = randomUUID();
    const run = await start(owner.userId, { ...body, workspace_ids: ['beta', 'alpha'] }, key);
    expect(
      (await stored(run.runId)).frozen_context.workspaceGrants.map((g) => g.workspace_id),
    ).toEqual(['alpha', 'beta']);
    await cancelConversationRun(deps, owner.userId, run.conversationId, run.runId, randomUUID(), {
      idempotency_key: randomUUID(),
    });
    await configureWorkspaceRegistry([c]);
    const replay = await start(owner.userId, { ...body, workspace_ids: ['alpha', 'beta'] }, key);
    expect(replay.runId).toBe(run.runId);
    expect(replay.context).toBeNull();
    expect(replay.replay?.at(-1)?.type).toBe('thread.cancelled');
    await expect(
      start(owner.userId, { ...body, workspace_ids: ['alpha', 'charlie'] }, key),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(
      (await stored(run.runId)).frozen_context.workspaceGrants.map((g) => g.workspace_id),
    ).toEqual(['alpha', 'beta']);
  });

  it('rejects foreign, missing, duplicate and revoked explicit selections before persisting a run', async () => {
    const owner = await seedAdmittedSession(database.pool);
    const other = await seedAdmittedSession(database.pool);
    const own = await registration(owner.userId, 'own');
    const foreign = await registration(other.userId, 'foreign');
    await configureWorkspaceRegistry([own, foreign]);
    for (const workspace_ids of [
      ['foreign'],
      ['own', 'foreign'],
      ['missing'],
      ['own', 'own'],
      [],
    ]) {
      await expect(start(owner.userId, { ...body, workspace_ids })).rejects.toThrow();
    }
    await configureWorkspaceRegistry([foreign]);
    await expect(start(owner.userId, { ...body, workspace_ids: ['own'] })).rejects.toThrow();
    const count = await database.pool.query<{ n: number }>(
      'SELECT count(*)::int n FROM agent_runs WHERE owner_id=$1',
      [owner.userId],
    );
    expect(count.rows[0]?.n).toBe(0);
  });

  it('never expands an old run when registrations are added and denies revoked or changed grants', async () => {
    const owner = await seedAdmittedSession(database.pool);
    const first = await registration(owner.userId, 'first');
    const later = await registration(owner.userId, 'later');
    await configureWorkspaceRegistry([first]);
    const run = await start(owner.userId);
    const original = (await stored(run.runId)).frozen_context.workspaceGrants;
    await configureWorkspaceRegistry([first, later]);
    const frozen = (await stored(run.runId)).frozen_context.workspaceGrants;
    expect(frozen).toEqual(original);
    expect(() => resolveFrozenWorkspaceGrant(owner.userId, frozen, 'later')).toThrow();
    expect(resolveFrozenWorkspaceGrant(owner.userId, frozen, 'first')).toEqual(original[0]);
    const newer = await start(owner.userId);
    expect(
      (await stored(newer.runId)).frozen_context.workspaceGrants.map((g) => g.workspace_id),
    ).toEqual(['first', 'later']);
    await configureWorkspaceRegistry([{ ...first, label: 'changed' }, later]);
    expect(() => resolveFrozenWorkspaceGrant(owner.userId, frozen, 'first')).toThrow();
    await configureWorkspaceRegistry([later]);
    expect(() => resolveFrozenWorkspaceGrant(owner.userId, frozen, 'first')).toThrow();
    expect((await stored(run.runId)).frozen_context.workspaceGrants).toEqual(original);
  });
});
