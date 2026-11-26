import type { Pool, PoolClient } from 'pg';
import { withClient, withTransaction } from '../../db/transaction.js';
import { forbidden, notFound, stateConflict } from '../../platform/errors.js';
import { isActiveOwner, lockViewerAccess, type Actor } from '../identity/public.js';
import { lockOwner, resolveSelection } from '../model-providers/public.js';
import { getWorkspaceGrant, WorkspaceDeniedError } from '../workspaces/public.js';
import type { PersonalBot, PersonalBotConfig } from './schemas.js';

export type { PersonalBot, PersonalBotConfig } from './schemas.js';

/** Hold the complete revision against config changes through the caller's transaction. */
export async function lockPersonalBot(
  client: Pick<PoolClient, 'query'>,
  ownerId: string,
  botId: string,
): Promise<PersonalBot | null> {
  const { rows } = await client.query<PersonalBot>(
    'SELECT id, revision, config FROM personal_bots WHERE owner_id=$1 AND id=$2 FOR SHARE',
    [ownerId, botId],
  );
  return rows[0] ?? null;
}

export async function listPersonalBots(pool: Pool, ownerId: string): Promise<PersonalBot[]> {
  return withClient(pool, async (client) => {
    if (!(await isActiveOwner(client, ownerId))) throw forbidden('owner authorization revoked');
    const { rows } = await client.query<PersonalBot>(
      'SELECT id, revision, config FROM personal_bots WHERE owner_id=$1 ORDER BY id',
      [ownerId],
    );
    return rows;
  });
}

export async function getPersonalBot(
  pool: Pool,
  ownerId: string,
  botId: string,
): Promise<PersonalBot> {
  return withClient(pool, async (client) => {
    if (!(await isActiveOwner(client, ownerId))) throw forbidden('owner authorization revoked');
    const { rows } = await client.query<PersonalBot>(
      'SELECT id, revision, config FROM personal_bots WHERE owner_id=$1 AND id=$2',
      [ownerId, botId],
    );
    if (!rows[0]) throw notFound('Bot not found');
    return rows[0];
  });
}

export async function requirePersonalBot(
  db: Pick<PoolClient, 'query'>,
  ownerId: string,
  botId: string,
): Promise<void> {
  const result = await db.query('SELECT 1 FROM personal_bots WHERE owner_id=$1 AND id=$2', [
    ownerId,
    botId,
  ]);
  if (!result.rowCount) throw notFound('Bot not found');
}

async function validateConfigGrants(
  client: PoolClient,
  ownerId: string,
  config: PersonalBotConfig,
) {
  try {
    for (const id of config.workspace_ids) getWorkspaceGrant(ownerId, id);
  } catch (error) {
    if (error instanceof WorkspaceDeniedError) throw forbidden('workspace unavailable');
    throw error;
  }
  if (config.model_selection) await resolveSelection(client, ownerId, config.model_selection);
}

export async function createPersonalBot(pool: Pool, actor: Actor, config: PersonalBotConfig) {
  return withTransaction(pool, async (client) => {
    if (!(await lockViewerAccess(client, actor.ownerId, actor.sessionId)))
      throw forbidden('owner authorization revoked');
    await validateConfigGrants(client, actor.ownerId, config);
    const { rows } = await client.query<PersonalBot>(
      'INSERT INTO personal_bots (owner_id, config) VALUES ($1,$2) RETURNING id, revision, config',
      [actor.ownerId, config],
    );
    return rows[0]!;
  });
}

export async function updatePersonalBot(
  pool: Pool,
  actor: Actor,
  botId: string,
  revision: number,
  config: PersonalBotConfig,
) {
  return withTransaction(pool, async (client) => {
    if (!(await lockViewerAccess(client, actor.ownerId, actor.sessionId)))
      throw forbidden('owner authorization revoked');
    // Match message admission: identity, model owner, then Bot.
    await lockOwner(client, actor.ownerId);
    const current = await client.query<{ revision: number }>(
      'SELECT revision FROM personal_bots WHERE owner_id=$1 AND id=$2 FOR UPDATE',
      [actor.ownerId, botId],
    );
    if (!current.rows[0]) throw notFound('Bot not found');
    if (current.rows[0].revision !== revision) throw stateConflict('Bot revision is stale');
    await validateConfigGrants(client, actor.ownerId, config);
    const { rows } = await client.query<PersonalBot>(
      `UPDATE personal_bots SET revision=revision+1, config=$3 WHERE owner_id=$1 AND id=$2
       RETURNING id, revision, config`,
      [actor.ownerId, botId, config],
    );
    return rows[0]!;
  });
}

export { botScopeAllows, lockRunBotScope, type BotScope } from './run-scope.js';
