import type { PoolClient } from 'pg';
import { forbidden } from '../../platform/errors.js';

type Binding = { ownerId: string; conversationId: string; runId: string };
export type BotScope = { tool_ids: string[]; workspace_ids: string[] };

/** Keep the current range stable through the caller's local effect or disclosure decision. */
export async function lockRunBotScope(
  client: Pick<PoolClient, 'query'>,
  binding: Binding,
): Promise<BotScope> {
  const { rows } = await client.query<{
    bot_id: string;
    frozen_bot_id: string | null;
    config: BotScope;
  }>(
    `SELECT c.bot_id, r.frozen_context->'personalBot'->>'id' AS frozen_bot_id, b.config
       FROM agent_runs r
       JOIN conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
       JOIN personal_bots b ON b.id=c.bot_id AND b.owner_id=c.owner_id
      WHERE r.owner_id=$1 AND r.conversation_id=$2 AND r.id=$3
      FOR SHARE OF b`,
    [binding.ownerId, binding.conversationId, binding.runId],
  );
  const row = rows[0];
  if (!row) throw forbidden('Run Bot not found');
  if (row.frozen_bot_id && row.frozen_bot_id !== row.bot_id)
    throw forbidden('Run Bot binding changed');
  return row.config;
}

/** Run-level checks still enforce the frozen allowlist and grants independently. */
export function botScopeAllows(scope: BotScope, toolId: string, workspaceId?: string): boolean {
  return (
    scope.tool_ids.includes(toolId) && (!workspaceId || scope.workspace_ids.includes(workspaceId))
  );
}
