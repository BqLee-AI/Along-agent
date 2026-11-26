import { Elysia } from 'elysia';
import type { HttpAccess } from '../../http/access.js';
import { idempotencyKeyOf, queryOf } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { errorResponses, responses } from '../../http/model.js';
import { literalUuidAt } from '../../http/request/path.js';
import { validationError } from '../../platform/errors.js';
import type { ConversationDeps } from '../../agent/execution/contracts.js';
import {
  startConversationRun,
  startIdleCompact,
  cancelConversationRun,
  getRunView,
  resumeConversationRun,
  continueConversationPause,
  requestConversationPause,
  getCompactReceipt,
  requestRuntimeCompactPause,
} from '../../agent/run/public.js';
import {
  getConversationBot,
  getConversationList,
  getConversationMessages,
  getConversationRuns,
  getConversationDetail,
} from './public.js';
import { streamRun, subscribeRun } from './run-event-response.js';
import { ActionKeySchema, ConversationEventsQuerySchema } from './schemas.js';
import * as model from './model.js';
export const conversationWriteScopes = ['/api/v1/conversations/'] as const;
function conversationId(path: string) {
  return literalUuidAt(path, 3, 'conversation not found');
}
function validateConversationPath({ path, params }: { path: string; params: { id: string } }) {
  params.id = conversationId(path);
}
function validateRunPath({ path, params }: { path: string; params: { id: string; run: string } }) {
  params.id = literalUuidAt(path, 3, 'Run not found');
  params.run = literalUuidAt(path, 5, 'Run not found');
}
function actionKey(request: Request) {
  const key = idempotencyKeyOf(request);
  if (!ActionKeySchema.safeParse(key).success) throw validationError('invalid compact request');
  return key!;
}
export function createConversationController(deps: ConversationDeps, access: HttpAccess) {
  return new Elysia({ name: 'conversations', strictPath: true })
    .resolve({ as: 'local' }, async ({ request }) => ({
      actor: await access.requireActor(request),
      requestId: access.requestId(request),
    }))
    .get(
      '/api/v1/conversations',
      async ({ actor, request, requestId }) =>
        okEnvelope(await getConversationList(deps, actor.ownerId, queryOf(request)), requestId),
      { response: responses(model.ConversationListPageSchema) },
    )
    .post(
      '/api/v1/conversations/messages',
      async ({ actor, request, body, requestId }) => {
        const started = await startConversationRun(
          deps,
          actor.ownerId,
          requestId,
          body,
          idempotencyKeyOf(request),
          actor.sessionId,
        );
        return streamRun(deps, started, actor, requestId);
      },
      { parse: access.parser(), body: model.SendMessageBodySchema, response: errorResponses },
    )
    .get(
      '/api/v1/conversations/:id',
      async ({ actor, request, path, requestId }) =>
        okEnvelope(
          await getConversationDetail(deps, actor.ownerId, conversationId(path), queryOf(request)),
          requestId,
        ),
      { response: responses(model.ConversationDetailSchema) },
    )
    .get(
      '/api/v1/conversations/:id/bot',
      async ({ actor, path, requestId }) =>
        okEnvelope(await getConversationBot(deps, actor.ownerId, conversationId(path)), requestId),
      { response: responses(model.ConversationBotSchema) },
    )
    .get(
      '/api/v1/conversations/:id/messages',
      async ({ actor, request, path, requestId }) =>
        okEnvelope(
          await getConversationMessages(
            deps,
            actor.ownerId,
            conversationId(path),
            queryOf(request),
          ),
          requestId,
        ),
      { response: responses(model.ConversationMessagePageSchema) },
    )
    .get(
      '/api/v1/conversations/:id/runs',
      async ({ actor, request, path, requestId }) =>
        okEnvelope(
          await getConversationRuns(deps, actor.ownerId, conversationId(path), queryOf(request)),
          requestId,
        ),
      { response: responses(model.ConversationRunPageSchema) },
    )
    .get(
      '/api/v1/conversations/:id/runs/:run',
      async ({ actor, path, requestId }) =>
        okEnvelope(
          await getRunView(
            deps,
            actor.ownerId,
            literalUuidAt(path, 3, 'Run not found'),
            literalUuidAt(path, 5, 'Run not found'),
          ),
          requestId,
        ),
      { response: responses(model.RunViewSchema) },
    )
    .get(
      '/api/v1/conversations/:id/runs/:run/events',
      async ({ actor, request, path, requestId }) => {
        const id = literalUuidAt(path, 3, 'Run not found');
        const run = literalUuidAt(path, 5, 'Run not found');
        const parsed = ConversationEventsQuerySchema.safeParse(queryOf(request));
        if (
          !parsed.success ||
          parsed.data.run_id !== undefined ||
          new URL(request.url).searchParams.has('limit')
        )
          throw validationError('invalid events query');
        return subscribeRun(deps, actor, id, run, requestId, parsed.data.after_seq ?? null);
      },
      { response: errorResponses },
    )
    .get(
      '/api/v1/conversations/:id/runs/:run/compacts/:pause',
      async ({ actor, path, requestId }) =>
        okEnvelope(
          await getCompactReceipt(
            deps,
            actor.ownerId,
            literalUuidAt(path, 3, 'compact operation not found'),
            literalUuidAt(path, 5, 'compact operation not found'),
            literalUuidAt(path, 7, 'compact operation not found'),
          ),
          requestId,
        ),
      { response: responses(model.CompactReceiptSchema) },
    )
    .post(
      '/api/v1/conversations/:id/actions/compact',
      async ({ actor, request, params, requestId }) => {
        const conversationId = params.id;
        const result = await startIdleCompact(
          deps,
          actor.ownerId,
          conversationId,
          requestId,
          actionKey(request),
        );
        return okEnvelope(
          result.status === 'no_content'
            ? { status: 'no_content' as const, run_id: null, pause_id: null }
            : await getCompactReceipt(
                deps,
                actor.ownerId,
                conversationId,
                result.runId,
                result.pauseId,
              ),
          requestId,
        );
      },
      {
        parse: access.parser(),
        transform: validateConversationPath,
        body: model.CompactRunBodySchema,
        response: responses(model.IdleCompactResultSchema),
      },
    )
    .post(
      '/api/v1/conversations/:id/runs/:run/actions/cancel',
      async ({ actor, params, body, requestId }) =>
        okEnvelope(
          await cancelConversationRun(deps, actor.ownerId, params.id, params.run, requestId, body),
          requestId,
        ),
      {
        parse: access.parser(),
        transform: validateRunPath,
        body: model.CancelRunBodySchema,
        response: responses(model.RunViewSchema),
      },
    )
    .post(
      '/api/v1/conversations/:id/runs/:run/actions/resume',
      async ({ actor, params, body, requestId }) =>
        streamRun(
          deps,
          await resumeConversationRun(deps, actor.ownerId, params.id, params.run, requestId, body),
          actor,
          requestId,
        ),
      {
        parse: access.parser(),
        transform: validateRunPath,
        body: model.ResumeRunBodySchema,
        response: errorResponses,
      },
    )
    .post(
      '/api/v1/conversations/:id/runs/:run/actions/pause',
      async ({ actor, request, params, body, requestId }) =>
        okEnvelope(
          await requestConversationPause(
            deps,
            actor.ownerId,
            params.id,
            params.run,
            body,
            idempotencyKeyOf(request),
          ),
          requestId,
        ),
      {
        parse: access.parser(),
        transform: validateRunPath,
        body: model.PauseRunBodySchema,
        response: responses(model.PauseResultSchema),
      },
    )
    .post(
      '/api/v1/conversations/:id/runs/:run/actions/continue',
      async ({ actor, request, params, body, requestId }) =>
        streamRun(
          deps,
          await continueConversationPause(
            deps,
            actor.ownerId,
            params.id,
            params.run,
            requestId,
            body,
            idempotencyKeyOf(request),
          ),
          actor,
          requestId,
        ),
      {
        parse: access.parser(),
        transform: validateRunPath,
        body: model.ContinueRunBodySchema,
        response: errorResponses,
      },
    )
    .post(
      '/api/v1/conversations/:id/runs/:run/actions/compact',
      async ({ actor, request, params, requestId }) => {
        const pending = await requestRuntimeCompactPause(
          deps,
          actor.ownerId,
          params.id,
          params.run,
          'manual_compact',
          actionKey(request),
        );
        return okEnvelope(
          await getCompactReceipt(deps, actor.ownerId, params.id, params.run, pending.pause_id),
          requestId,
        );
      },
      {
        parse: access.parser(),
        transform: validateRunPath,
        body: model.CompactRunBodySchema,
        response: responses(model.CompactReceiptSchema),
      },
    );
}
