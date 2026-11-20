import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { FeishuBotDocxConfiguration } from './feishu-bot-docx-config.js';

export async function readFeishuBotDocxBinding(
  client: PoolClient,
  config: FeishuBotDocxConfiguration,
  ownerId: string,
  url: string,
  expectedGeneration?: string,
) {
  if (ownerId !== config.ownerId || !config.documents.includes(url)) return null;
  const { rows } = await client.query<{ attempt_id: string; bot_name: string }>(
    `SELECT attempt_id, bot_name FROM feishu_bot_connections
      WHERE owner_id=$1 AND app_id=$2 AND session_id IS NULL
        AND ($3::uuid IS NULL OR attempt_id=$3::uuid)
      FOR SHARE`,
    [ownerId, config.appId, expectedGeneration ?? null],
  );
  const binding = rows[0];
  return binding ? { generation: binding.attempt_id, botName: binding.bot_name } : null;
}

export const feishuBotDocxGrantSchema = z
  .object({
    kind: z.literal('feishu-docx-bot/1'),
    connectionId: z.string().uuid(),
    revision: z.string().uuid(),
    generation: z.string().uuid(),
    appId: z.string().regex(/^cli_[a-z0-9]{12,64}$/iu),
    sessionId: z.string().uuid(),
    url: z.string().regex(/^https:\/\/[a-z0-9-]+\.feishu\.cn\/docx\/[A-Za-z0-9]{27}$/u),
  })
  .strict();

export type FeishuBotDocxGrant = z.infer<typeof feishuBotDocxGrantSchema>;

export async function freezeFeishuBotDocxGrant(
  client: PoolClient,
  config: FeishuBotDocxConfiguration,
  viewer: { ownerId: string; sessionId: string },
  url: string,
): Promise<FeishuBotDocxGrant | null> {
  const binding = await readFeishuBotDocxBinding(client, config, viewer.ownerId, url);
  if (!binding) return null;
  return {
    kind: 'feishu-docx-bot/1',
    connectionId: config.connectionId,
    revision: config.revision,
    generation: binding.generation,
    appId: config.appId,
    sessionId: viewer.sessionId,
    url,
  };
}

export async function matchFeishuBotDocxGrant(
  client: PoolClient,
  config: FeishuBotDocxConfiguration,
  viewer: { ownerId: string; sessionId: string },
  grant: FeishuBotDocxGrant,
) {
  if (
    grant.connectionId !== config.connectionId ||
    grant.revision !== config.revision ||
    grant.appId !== config.appId ||
    grant.sessionId !== viewer.sessionId
  )
    return null;
  return readFeishuBotDocxBinding(client, config, viewer.ownerId, grant.url, grant.generation);
}
