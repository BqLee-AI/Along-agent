import { Elysia } from 'elysia';
import type { HttpAccess } from '../../http/access.js';
import { idempotencyKeyOf, queryOf } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { errorResponses, responses } from '../../http/model.js';
import { isUuid, notFound, validationError } from '../../platform/errors.js';
import type { ConversationDeps } from '../../agent/runtime/contracts.js';
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
} from '../../agent/operations/public.js';
import {
  getConversationList,
  getConversationMessages,
  getConversationRuns,
  getConversationDetail,
} from './public.js';
import { streamRun, subscribeRun } from './run-event-response.js';
import { ActionKeySchema, ConversationEventsQuerySchema } from './schemas.js';
import * as model from './model.js';
export const conversationWriteScopes = ['/api/v1/conversations/'] as const;
function id(value: string, name = 'conversation') {
  if (!isUuid(value)) throw notFound(name + ' not found');
  return value;
}
function actionKey(request: Request) {
  const key = idempotencyKeyOf(request);
  if (!ActionKeySchema.safeParse(key).success) throw validationError('invalid compact request');
  return key!;
}
export function createConversationController(deps: ConversationDeps, access: HttpAccess) {
  return new Elysia({ name: 'conversations', strictPath: true })
    .resolve({ as: 'local' }, async ({ request }) => {
      const actor = await access.requireActor(request);
      // Elysia decodes path parameters; the API requires literal identifiers.
      if (new URL(request.url).pathname.includes('%')) throw notFound('conversation not found');
      return { actor, requestId: access.requestId(request) };
    })
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
        );
        return streamRun(deps, started, actor, requestId);
      },
      { parse: access.parser(), body: model.SendMessageBodySchema, response: errorResponses },
    )
    .get(
      '/api/v1/conversations/:id',
      async ({ actor, request, params, requestId }) =>
        okEnvelope(
          await getConversationDetail(deps, actor.ownerId, id(params.id), queryOf(request)),
          requestId,
        ),
      { response: responses(model.ConversationDetailSchema) },
    )
    .get(
      '/api/v1/conversations/:id/messages',
      async ({ actor, request, params, requestId }) =>
        okEnvelope(
          await getConversationMessages(deps, actor.ownerId, id(params.id), queryOf(request)),
          requestId,
        ),
      { response: responses(model.ConversationMessagePageSchema) },
    )
    .get(
      '/api/v1/conversations/:id/runs',
      async ({ actor, request, params, requestId }) =>
        okEnvelope(
          await getConversationRuns(deps, actor.ownerId, id(params.id), queryOf(request)),
          requestId,
        ),
      { response: responses(model.ConversationRunPageSchema) },
    )
    .get(
      '/api/v1/conversations/:id/runs/:run',
      async ({ actor, params, requestId }) =>
        okEnvelope(
          await getRunView(deps, actor.ownerId, id(params.id, 'Run'), id(params.run, 'Run')),
          requestId,
        ),
      { response: responses(model.RunViewSchema) },
    )
    .get(
      '/api/v1/conversations/:id/runs/:run/events',
      async ({ actor, request, params, requestId }) => {
        id(params.id, 'Run');
        id(params.run, 'Run');
        const parsed = ConversationEventsQuerySchema.safeParse(queryOf(request));
        if (
          !parsed.success ||
          parsed.data.run_id !== undefined ||
          new URL(request.url).searchParams.has('limit')
        )
          throw validationError('invalid events query');
        return subscribeRun(
          deps,
          actor,
          params.id,
          params.run,
          requestId,
          parsed.data.after_seq ?? null,
        );
      },
      { response: errorResponses },
    )
    .get(
      '/api/v1/conversations/:id/runs/:run/compacts/:pause',
      async ({ actor, params, requestId }) =>
        okEnvelope(
          await getCompactReceipt(
            deps,
            actor.ownerId,
            id(params.id, 'compact operation'),
            id(params.run, 'compact operation'),
            id(params.pause, 'compact operation'),
          ),
          requestId,
        ),
      { response: responses(model.CompactReceiptSchema) },
    )
    .post(
      '/api/v1/conversations/:id/actions/compact',
      async ({ actor, request, params, requestId }) => {
        const conversationId = id(params.id);
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
        body: model.CompactRunBodySchema,
        response: responses(model.IdleCompactResultSchema),
      },
    )
    .post(
      '/api/v1/conversations/:id/runs/:run/actions/cancel',
      async ({ actor, params, body, requestId }) =>
        okEnvelope(
          await cancelConversationRun(
            deps,
            actor.ownerId,
            id(params.id, 'Run'),
            id(params.run, 'Run'),
            requestId,
            body,
          ),
          requestId,
        ),
      {
        parse: access.parser(),
        body: model.CancelRunBodySchema,
        response: responses(model.RunViewSchema),
      },
    )
    .post(
      '/api/v1/conversations/:id/runs/:run/actions/resume',
      async ({ actor, params, body, requestId }) =>
        streamRun(
          deps,
          await resumeConversationRun(
            deps,
            actor.ownerId,
            id(params.id, 'Run'),
            id(params.run, 'Run'),
            requestId,
            body,
          ),
          actor,
          requestId,
        ),
      { parse: access.parser(), body: model.ResumeRunBodySchema, response: errorResponses },
    )
    .post(
      '/api/v1/conversations/:id/runs/:run/actions/pause',
      async ({ actor, request, params, body, requestId }) =>
        okEnvelope(
          await requestConversationPause(
            deps,
            actor.ownerId,
            id(params.id, 'Run'),
            id(params.run, 'Run'),
            body,
            idempotencyKeyOf(request),
          ),
          requestId,
        ),
      {
        parse: access.parser(),
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
            id(params.id, 'Run'),
            id(params.run, 'Run'),
            requestId,
            body,
            idempotencyKeyOf(request),
          ),
          actor,
          requestId,
        ),
      { parse: access.parser(), body: model.ContinueRunBodySchema, response: errorResponses },
    )
    .post(
      '/api/v1/conversations/:id/runs/:run/actions/compact',
      async ({ actor, request, params, requestId }) => {
        id(params.id, 'Run');
        id(params.run, 'Run');
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
        body: model.CompactRunBodySchema,
        response: responses(model.CompactReceiptSchema),
      },
    );
}
