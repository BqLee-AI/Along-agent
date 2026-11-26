import { ConversationListPageSchema } from '@along/contracts';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { z } from 'zod';
import { idempotencyKeyOf, queryOf, type HttpAccess } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { responses } from '../../http/model.js';
import { literalUuidAt } from '../../http/request/path.js';
import { notReady, validationError } from '../../platform/errors.js';
import {
  ActionKeySchema,
  createBotConversation,
  getConversationList,
} from '../conversations/public.js';
import {
  createPersonalBot,
  getPersonalBot,
  listPersonalBots,
  updatePersonalBot,
} from './public.js';
import { PersonalBotConfigSchema, PersonalBotSchema, UpdatePersonalBotSchema } from './schemas.js';

export const botWriteScopes = ['/api/v1/bots'] as const;
const ConversationCreatedSchema = z.object({ conversation_id: z.string().uuid() }).strict();
const BotConversationBodySchema = z.object({}).strict();
const BotListSchema = z.object({ items: z.array(PersonalBotSchema) }).strict();

function botIdOf(path: string) {
  return literalUuidAt(path, 3, 'Bot not found').toLowerCase();
}

function validateBotPath({ path, params }: { path: string; params: { botId: string } }) {
  params.botId = botIdOf(path);
}

export function createBotController(pool: Pool | null, access: HttpAccess) {
  function db() {
    if (!pool) throw notReady();
    return pool;
  }
  return new Elysia({ name: 'bots', strictPath: true })
    .resolve({ as: 'local' }, async ({ request }) => ({
      actor: await access.requireActor(request),
      requestId: access.requestId(request),
    }))
    .get(
      '/api/v1/bots',
      async ({ actor, requestId }) =>
        okEnvelope({ items: await listPersonalBots(db(), actor.ownerId) }, requestId),
      { response: responses(BotListSchema) },
    )
    .post(
      '/api/v1/bots',
      async ({ actor, body, requestId }) =>
        okEnvelope(await createPersonalBot(db(), actor, body), requestId),
      {
        parse: access.parser(),
        body: PersonalBotConfigSchema,
        response: responses(PersonalBotSchema),
      },
    )
    .get(
      '/api/v1/bots/:botId',
      async ({ actor, path, requestId }) => {
        const botId = botIdOf(path);
        return okEnvelope(await getPersonalBot(db(), actor.ownerId, botId), requestId);
      },
      { response: responses(PersonalBotSchema) },
    )
    .post(
      '/api/v1/bots/:botId',
      async ({ actor, params, body: { revision, ...config }, requestId }) =>
        okEnvelope(await updatePersonalBot(db(), actor, params.botId, revision, config), requestId),
      {
        parse: access.parser(),
        transform: validateBotPath,
        body: UpdatePersonalBotSchema,
        response: responses(PersonalBotSchema),
      },
    )
    .get(
      '/api/v1/bots/:botId/conversations',
      async ({ actor, path, request, requestId }) =>
        okEnvelope(
          await getConversationList({ pool }, actor.ownerId, queryOf(request), botIdOf(path)),
          requestId,
        ),
      { response: responses(ConversationListPageSchema) },
    )
    .post(
      '/api/v1/bots/:botId/conversations',
      async ({ actor, params, request, requestId }) => {
        const key = ActionKeySchema.safeParse(idempotencyKeyOf(request));
        if (!key.success) throw validationError('invalid conversation creation idempotency key');
        return okEnvelope(
          await createBotConversation(db(), actor, params.botId, key.data),
          requestId,
        );
      },
      {
        parse: access.parser(),
        transform: validateBotPath,
        body: BotConversationBodySchema,
        response: responses(ConversationCreatedSchema),
      },
    );
}
