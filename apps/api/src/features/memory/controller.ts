import { Elysia } from 'elysia';
import type { HttpAccess } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { responses } from '../../http/model.js';
import { literalUuidAt } from '../../http/request/path.js';
import { notFound, notReady, validationError } from '../../platform/errors.js';
import type { MemoryService } from './public.js';
import * as model from './model.js';

// Root write plus descendants, using the router's exact-or-slash scope matcher.
export const memoryWriteScopes = ['/api/v1/memories'] as const;
function validateMemoryPath({ path, params }: { path: string; params: { id: string } }) {
  params.id = literalUuidAt(path, 3, 'memory not found');
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
      async ({ service, actor, path, requestId }) => {
        const id = literalUuidAt(path, 3, 'memory not found');
        const memory = await service.get(actor.ownerId, id);
        if (!memory) throw notFound('memory not found');
        return okEnvelope(memory, requestId);
      },
      { response: responses(model.MemorySchema) },
    )
    .post(
      '/api/v1/memories',
      async ({ service, actor, body, requestId }) =>
        okEnvelope(await service.createManual(actor.ownerId, body), requestId),
      {
        parse: access.parser({
          ready: () => {
            if (!service) throw notReady('memory unavailable');
          },
        }),
        body: model.ManualCreateSchema,
        response: responses(model.MemorySchema),
      },
    )
    .post(
      '/api/v1/memories/:id/actions/correct-manual',
      async ({ service, actor, params, body, requestId }) =>
        okEnvelope(await service.correctManual(actor.ownerId, params.id, body), requestId),
      {
        parse: access.parser({
          ready: () => {
            if (!service) throw notReady('memory unavailable');
          },
        }),
        transform: validateMemoryPath,
        body: model.ManualCorrectionSchema,
        response: responses(model.MemorySchema),
      },
    )
    .post(
      '/api/v1/memories/:id/actions/correct',
      async ({ service, actor, params, body, requestId }) =>
        okEnvelope(await service.correct(actor.ownerId, params.id, body), requestId),
      {
        parse: access.parser({
          ready: () => {
            if (!service) throw notReady('memory unavailable');
          },
        }),
        transform: validateMemoryPath,
        body: model.CorrectionSchema,
        response: responses(model.MemorySchema),
      },
    )
    .post(
      '/api/v1/memories/:id/actions/stop-recall',
      async ({ service, actor, params, body, requestId }) => {
        const id = params.id;
        await service.stopRecall(actor.ownerId, id, body.expectedRevision);
        return okEnvelope({ id, status: 'stopped' as const }, requestId);
      },
      {
        parse: access.parser({
          ready: () => {
            if (!service) throw notReady('memory unavailable');
          },
        }),
        transform: validateMemoryPath,
        body: model.StopSchema,
        response: responses(model.StoppedSchema),
      },
    );
}
