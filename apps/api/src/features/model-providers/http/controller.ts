import { Elysia } from 'elysia';
import { z } from 'zod';
import * as model from './model.js';
import { responses } from '../../../http/model.js';
import { okEnvelope } from '../../../http/errors.js';
import type { HttpAccess } from '../../../http/access.js';
import type { AppDeps } from '../../../http/contracts.js';
import { isUuid, notReady, validationError } from '../../../platform/errors.js';
import {
  addModel,
  createProvider,
  deleteProvider,
  listProviders,
  removeModel,
  setDefault,
  setModelContextWindow,
  setProviderDefault,
  syncModels,
  updateProvider,
  testProvider,
  testProviderConnection,
} from '../public.js';
import {
  MAX_OFFICE_NOTES_BYTES,
  officeSummaryEnabled,
  summarizeOfficeNotes,
} from '../outbound/summarize-office-notes.js';

export const modelSelectionWritePath = '/api/v1/model-selection/actions/set-default' as const;
export const modelProviderWriteScopes = ['/api/v1/model-providers'] as const;
const officeNotesSchema = z.strictObject({
  notes: z
    .string()
    .refine(
      (notes) =>
        notes.isWellFormed() &&
        Buffer.byteLength(notes, 'utf8') <= MAX_OFFICE_NOTES_BYTES &&
        notes.trim().length > 0,
      'invalid meeting notes',
    ),
});
function providerId(id: string) {
  if (!isUuid(id)) throw validationError('invalid provider id');
  return id;
}
export function createModelProviderController(
  deps: Pick<AppDeps, 'pool' | 'modelTransport'>,
  access: HttpAccess,
) {
  const parse = access.parser({
    model: true,
    ready: () => {
      if (!deps.pool) throw notReady();
    },
  });
  return new Elysia({ name: 'model-providers', strictPath: true })
    .get(
      '/api/v1/model-providers/office-capability',
      async ({ request }) => {
        await access.requireActor(request);
        return okEnvelope({ enabled: officeSummaryEnabled() }, access.requestId(request));
      },
      { response: responses(z.object({ enabled: z.boolean() })) },
    )
    .resolve({ as: 'local' }, async ({ request }) => {
      const actor = await access.requireActor(request);
      if (!deps.pool) throw notReady();
      return { owner: actor.ownerId, pool: deps.pool, requestId: access.requestId(request) };
    })
    .get(
      '/api/v1/model-providers',
      async ({ pool, owner, requestId }) => okEnvelope(await listProviders(pool, owner), requestId),
      { response: responses(model.ProviderListSchema) },
    )
    .post(
      '/api/v1/model-providers/actions/summarize-notes',
      async ({ pool, request, requestId, body }) =>
        okEnvelope(
          await summarizeOfficeNotes(
            pool,
            await access.requireActor(request),
            body.notes,
            deps.modelTransport,
            request.signal,
          ),
          requestId,
        ),
      { parse, body: officeNotesSchema, response: responses(z.object({ summary: z.string() })) },
    )
    .post(
      '/api/v1/model-providers',
      async ({ pool, owner, requestId, body }) =>
        okEnvelope(await createProvider(pool, owner, body.name), requestId),
      { parse, body: model.ProviderCreateSchema, response: responses(model.ProviderViewSchema) },
    )
    .post(
      modelSelectionWritePath,
      async ({ pool, owner, requestId, body }) => {
        await setDefault(pool, owner, body.selection);
        return okEnvelope({ selection: body.selection }, requestId);
      },
      {
        parse,
        body: model.ProviderDefaultSchema,
        response: responses(z.object({ selection: model.ModelSelectionSchema.nullable() })),
      },
    )
    .post(
      '/api/v1/model-providers/:id/actions/update',
      async ({ pool, owner, params, body, requestId }) =>
        okEnvelope(await updateProvider(pool, owner, providerId(params.id), body), requestId),
      { parse, body: model.ProviderUpdateSchema, response: responses(model.ProviderViewSchema) },
    )
    .post(
      '/api/v1/model-providers/:id/actions/delete',
      async ({ pool, owner, params, requestId }) => {
        await deleteProvider(pool, owner, providerId(params.id));
        return okEnvelope({ deleted: true as const }, requestId);
      },
      {
        parse,
        body: model.EmptyActionSchema,
        response: responses(z.object({ deleted: z.literal(true) })),
      },
    )
    .post(
      '/api/v1/model-providers/:id/actions/default-model',
      async ({ pool, owner, params, body, requestId }) =>
        okEnvelope(
          await setProviderDefault(pool, owner, providerId(params.id), body.model_id),
          requestId,
        ),
      {
        parse,
        body: model.ProviderModelDefaultSchema,
        response: responses(model.ProviderViewSchema),
      },
    )
    .post(
      '/api/v1/model-providers/:id/actions/test-connection',
      async ({ pool, owner, params, body, requestId }) =>
        okEnvelope(
          await testProviderConnection(pool, owner, providerId(params.id), body),
          requestId,
        ),
      {
        parse,
        body: model.ProviderConnectionTestSchema,
        response: responses(model.ProviderConnectionTestResultSchema),
      },
    )
    .post(
      '/api/v1/model-providers/:id/actions/test',
      async ({ pool, owner, params, body, requestId, request }) =>
        okEnvelope(
          await testProvider(
            pool,
            owner,
            providerId(params.id),
            body,
            deps.modelTransport,
            request.signal,
          ),
          requestId,
        ),
      {
        parse,
        body: model.ProviderTestSchema,
        response: responses(model.ProviderTestResultSchema),
      },
    )
    .post(
      '/api/v1/model-providers/:id/models',
      async ({ pool, owner, params, body, requestId }) =>
        okEnvelope(
          await addModel(
            pool,
            owner,
            providerId(params.id),
            body.model_id,
            body.context_window_tokens,
          ),
          requestId,
        ),
      {
        parse,
        body: model.ProviderModelCreateSchema,
        response: responses(model.ProviderViewSchema),
      },
    )
    .post(
      '/api/v1/model-providers/:id/models/actions/context-window',
      async ({ pool, owner, params, body, requestId }) =>
        okEnvelope(
          await setModelContextWindow(
            pool,
            owner,
            providerId(params.id),
            body.model_id,
            body.context_window_tokens,
          ),
          requestId,
        ),
      {
        parse,
        body: model.ProviderModelContextWindowSchema,
        response: responses(model.ProviderViewSchema),
      },
    )
    .post(
      '/api/v1/model-providers/:id/models/actions/remove',
      async ({ pool, owner, params, body, requestId }) =>
        okEnvelope(await removeModel(pool, owner, providerId(params.id), body.model_id), requestId),
      { parse, body: model.ProviderModelSchema, response: responses(model.ProviderViewSchema) },
    )
    .post(
      '/api/v1/model-providers/:id/models/actions/sync',
      async ({ pool, owner, params, requestId }) =>
        okEnvelope(await syncModels(pool, owner, providerId(params.id)), requestId),
      {
        parse,
        body: model.EmptyActionSchema,
        response: responses(
          z.object({ provider: model.ProviderViewSchema, added_model_ids: z.array(z.string()) }),
        ),
      },
    );
}
