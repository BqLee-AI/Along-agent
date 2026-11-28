import {
  ConversationListPageSchema,
  ModelSelectionSchema,
  workspaceSummarySchema,
} from '@along/contracts';
import { z } from 'zod';
import { readEnvelope } from '@/shared/http/client';
import { api, writeOptions, type ApiClient } from '@/shared/http/eden';
import { readHistoryCollectionPage } from '@/shared/http/page';
import { MeSchema } from '@/shared/session/identity';
import type { TaskIntent } from './task';

const id = z.string().uuid();
const BotConfigSchema = z
  .object({
    name: z.string(),
    introduction: z.string(),
    role: z.string(),
    instructions: z.string(),
    model_selection: ModelSelectionSchema.nullable(),
    tool_ids: z.array(z.string()),
    workspace_ids: z.array(workspaceSummarySchema.shape.workspace_id),
    skill_ids: z.array(id).optional(),
  })
  .strict();
const BotSchema = z
  .object({ id, revision: z.number().int().positive(), config: BotConfigSchema })
  .strict();
const BotListSchema = z.object({ items: z.array(BotSchema) }).strict();
const BotRelationSchema = z.object({ bot_id: id }).strict();
const ConversationCreatedSchema = z.object({ conversation_id: id }).strict();

export type PersonalBotConfig = z.infer<typeof BotConfigSchema>;
export type PersonalBot = z.infer<typeof BotSchema>;

export function botHref(
  botId: string,
  conversationId?: string | null,
  intent?: TaskIntent | null,
): string {
  const query = new URLSearchParams({ bot_id: botId });
  if (conversationId) query.set('conversation_id', conversationId);
  else if (intent && intent !== 'chat') query.set('intent', intent);
  return `/conversations?${query}`;
}

export async function readBots(
  _cursor: string | null,
  signal: AbortSignal,
  client: ApiClient = api,
) {
  const result = await client.api.v1.bots.get({ fetch: { signal } });
  return { items: BotListSchema.parse(await readEnvelope(result)).items, nextCursor: null };
}

export async function readSelectedBot(
  botId: string | null,
  conversationId: string | null,
  signal: AbortSignal,
  client: ApiClient = api,
): Promise<PersonalBot | null> {
  if (conversationId) {
    signal.throwIfAborted();
    const result = await client.api.v1
      .conversations({ id: conversationId })
      .bot.get({ fetch: { signal } });
    const actualBotId = BotRelationSchema.parse(await readEnvelope(result)).bot_id;
    if (botId && botId !== actualBotId) throw new Error('此会话不属于所选的 Bot。');
    botId = actualBotId;
  }
  if (!botId) return null;
  signal.throwIfAborted();
  const result = await client.api.v1.bots({ botId }).get({ fetch: { signal } });
  const bot = BotSchema.parse(await readEnvelope(result));
  if (bot.id !== botId) throw new Error('返回的 Bot 与读取地址不匹配。');
  return bot;
}

export function readBotConversations(
  botId: string,
  cursor: string | null,
  signal: AbortSignal,
  client: ApiClient = api,
) {
  return readHistoryCollectionPage(
    client.api.v1.bots({ botId }).conversations.get({
      query: { limit: '20', ...(cursor !== null ? { cursor } : {}) },
      fetch: { signal },
    }),
    ConversationListPageSchema,
  );
}

async function botWriteOptions(client: ApiClient, signal: AbortSignal, key?: string) {
  const me = MeSchema.parse(await readEnvelope(await client.api.v1.me.get({ fetch: { signal } })));
  signal.throwIfAborted();
  return writeOptions(me.csrf_token, signal, key);
}

export async function saveBot(
  previous: PersonalBot | null,
  config: PersonalBotConfig,
  signal: AbortSignal,
  client: ApiClient = api,
): Promise<PersonalBot> {
  const options = await botWriteOptions(client, signal);
  const data = previous
    ? await readEnvelope(
        await client.api.v1
          .bots({ botId: previous.id })
          .post({ ...config, revision: previous.revision }, options),
      )
    : await readEnvelope(await client.api.v1.bots.post(config, options));
  const saved = BotSchema.parse(data);
  if (previous && (saved.id !== previous.id || saved.revision <= previous.revision))
    throw new Error('保存回执与原 Bot 设置不匹配。');
  return saved;
}

export async function createBotConversation(
  botId: string,
  key: string,
  signal: AbortSignal,
  client: ApiClient = api,
) {
  const options = await botWriteOptions(client, signal, key);
  const result = await client.api.v1.bots({ botId }).conversations.post({}, options);
  return ConversationCreatedSchema.parse(await readEnvelope(result)).conversation_id;
}
