import type { Pool, PoolClient } from 'pg';
import type { ModelSelection } from '@along/contracts';
import {
  TOOL_IDS,
  DELEGATION_TOOL_IDS,
  DELEGATION_WORKSPACE_WRITE_TOOL_IDS,
  DELEGATION_WORKSPACE_CREATE_TOOL_IDS,
  R3_MEMORY_TOOL_IDS,
  R3_MEMORY_SOURCE_TOOL_ID,
} from '../../src/agent/tools/contracts.js';
import type { PersonalBotConfig } from '../../src/features/bots/public.js';
import { resolveWorkspaceGrants } from '../../src/features/workspaces/public.js';

const fixtureToolIds = [
  ...new Set([
    ...TOOL_IDS,
    ...DELEGATION_TOOL_IDS,
    ...DELEGATION_WORKSPACE_WRITE_TOOL_IDS,
    ...DELEGATION_WORKSPACE_CREATE_TOOL_IDS,
    ...R3_MEMORY_TOOL_IDS,
    R3_MEMORY_SOURCE_TOOL_ID,
    'feishu_docx_read',
    'learn_docs_search',
  ]),
];
type Queryable = Pick<Pool | PoolClient, 'query'>;

export function fixtureBotConfig(
  ownerId: string,
  modelSelection?: ModelSelection,
): PersonalBotConfig {
  return {
    name: 'Fixture Bot',
    introduction: '',
    role: '',
    instructions: '',
    model_selection: modelSelection ?? null,
    tool_ids: fixtureToolIds,
    workspace_ids: resolveWorkspaceGrants(ownerId).grants.map((grant) => grant.workspace_id),
  };
}

export async function seedFixtureBot(
  db: Queryable,
  ownerId: string,
  modelSelection?: ModelSelection,
): Promise<string> {
  const config = fixtureBotConfig(ownerId, modelSelection);
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO personal_bots (owner_id, config) VALUES ($1,$2) RETURNING id',
    [ownerId, config],
  );
  return rows[0]!.id;
}

export async function createFixtureConversation(
  db: Queryable,
  ownerId: string,
  options: { id?: string; modelSelection?: ModelSelection; title?: string; anchor?: string } = {},
): Promise<string> {
  const botId = await seedFixtureBot(db, ownerId, options.modelSelection);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO conversations (id, owner_id, bot_id, title, anchor_received_at_utc)
     VALUES (coalesce($1::uuid,gen_random_uuid()), $2,$3,$4,$5) RETURNING id`,
    [options.id ?? null, ownerId, botId, options.title ?? '', options.anchor ?? null],
  );
  return rows[0]!.id;
}
