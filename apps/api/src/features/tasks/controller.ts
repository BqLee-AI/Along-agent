import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import type { HttpAccess } from '../../http/access.js';
import { queryOf } from '../../http/access.js';
import { okEnvelope } from '../../http/errors.js';
import { responses } from '../../http/model.js';
import { isUuid, notFound } from '../../platform/errors.js';
import { requestCancel, getTaskDetail, getTaskEvents, listTasksForOwner } from './public.js';
import * as model from './model.js';
export const taskWriteScopes = ['/api/v1/tasks'] as const;
function taskId(id: string) {
  if (!isUuid(id)) throw notFound('task not found');
  return id;
}
export function createTaskController(deps: { pool: Pool | null }, access: HttpAccess) {
  return new Elysia({ name: 'tasks', strictPath: true })
    .resolve({ as: 'local' }, async ({ request }) => ({
      actor: await access.requireActor(request),
      requestId: access.requestId(request),
    }))
    .get(
      '/api/v1/tasks',
      async ({ actor, request, requestId }) =>
        okEnvelope(await listTasksForOwner(deps, actor.ownerId, queryOf(request)), requestId),
      { response: responses(model.TaskListSchema) },
    )
    .get(
      '/api/v1/tasks/:id',
      async ({ actor, params, requestId }) =>
        okEnvelope(await getTaskDetail(deps, actor.ownerId, taskId(params.id)), requestId),
      { response: responses(model.TaskDetailSchema) },
    )
    .get(
      '/api/v1/tasks/:id/events',
      async ({ actor, params, request, requestId }) =>
        okEnvelope(
          await getTaskEvents(deps, actor.ownerId, taskId(params.id), queryOf(request)),
          requestId,
        ),
      { response: responses(model.TaskEventsSchema) },
    )
    .post(
      '/api/v1/tasks/:id/actions/cancel',
      async ({ actor, params, body, requestId }) =>
        okEnvelope(await requestCancel(deps, actor.ownerId, taskId(params.id), body), requestId),
      {
        parse: access.parser(),
        body: model.CancelBodySchema,
        response: responses(model.CancelResultSchema),
      },
    );
}
