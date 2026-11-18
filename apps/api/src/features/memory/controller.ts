import { Elysia } from 'elysia';
import type { HttpAccess } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { responses } from '../../http/model.js';
import { isUuid, notFound, notReady, validationError } from '../../platform/errors.js';
import type { MemoryService } from './public.js';
import * as model from './model.js';
export const memoryWriteScopes = ['/api/v1/memories/'] as const;
function memoryId(id: string) {
  if (!isUuid(id)) throw notFound('memory not found');
  return id;
}
export function createMemoryController(service: MemoryService | undefined, access: HttpAccess) {
  return new Elysia({ name: 'memory', strictPath: true })
    .resolve({ as: 'local' }, async ({ request }) => {
      const actor = await access.requireActor(request);
      if (!service) throw notReady('memory unavailable');
      return { actor, service, requestId: access.requestId(request) };
    })
    .get(
      '/api/v1/memories',
      async ({ service, actor, request, requestId }) => {
        const params = new URL(request.url).searchParams;
        if (
          [...params.keys()].some((key) => key !== 'limit' && key !== 'cursor') ||
          params.getAll('limit').length > 1 ||
          params.getAll('cursor').length > 1
        )
          throw validationError('invalid memory query');
        const limit = params.get('limit');
        if (limit !== null && !/^[1-9][0-9]*$/.test(limit))
          throw validationError('invalid memory limit');
        return okEnvelope(
          await service.list(actor.ownerId, {
            ...(limit !== null ? { limit: Number(limit) } : {}),
            ...(params.has('cursor') ? { cursor: params.get('cursor')! } : {}),
          }),
          requestId,
        );
      },
      { response: responses(model.MemoryListSchema) },
    )
    .get(
      '/api/v1/memories/:id',
      async ({ service, actor, params, requestId }) => {
        const memory = await service.get(actor.ownerId, memoryId(params.id));
        if (!memory) throw notFound('memory not found');
        return okEnvelope(memory, requestId);
      },
      { response: responses(model.MemorySchema) },
    )
    .post(
      '/api/v1/memories/:id/actions/correct',
      async ({ service, actor, params, body, requestId }) =>
        okEnvelope(await service.correct(actor.ownerId, memoryId(params.id), body), requestId),
      {
        parse: access.parser({
          ready: () => {
            if (!service) throw notReady('memory unavailable');
          },
        }),
        body: model.CorrectionSchema,
        response: responses(model.MemorySchema),
      },
    )
    .post(
      '/api/v1/memories/:id/actions/stop-recall',
      async ({ service, actor, params, body, requestId }) => {
        const id = memoryId(params.id);
        await service.stopRecall(actor.ownerId, id, body.expectedRevision);
        return okEnvelope({ id, status: 'stopped' as const }, requestId);
      },
      {
        parse: access.parser({
          ready: () => {
            if (!service) throw notReady('memory unavailable');
          },
        }),
        body: model.StopSchema,
        response: responses(model.StoppedSchema),
      },
    );
}
