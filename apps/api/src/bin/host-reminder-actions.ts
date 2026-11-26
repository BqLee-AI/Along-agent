import { Elysia } from 'elysia';
import { ConfirmBodySchema, ConfirmResultSchema } from '../features/approvals/model.js';
import { confirmApproval } from '../features/approvals/public.js';
import { CancelBodySchema, CancelResultSchema } from '../features/tasks/model.js';
import { requestCancel } from '../features/tasks/public.js';
import { createAccess } from '../http/access.js';
import type { AppDeps } from '../http/contracts.js';
import { createErrorHandler, okEnvelope } from '../http/errors.js';
import { responses } from '../http/model.js';
import { literalUuidAt } from '../http/request/path.js';

const reminderActionPath =
  /^\/api\/v1\/(?:approvals\/[^/]+\/actions\/confirm|tasks\/[^/]+\/actions\/cancel)$/;

export function createHostReminderActions(deps: AppDeps) {
  const access = createAccess(deps);
  const parse = access.parser();
  const operations = { pool: deps.pool };
  const actions = new Elysia({ name: 'host-reminder-actions', strictPath: true, normalize: false })
    .onRequest(async ({ request, set }) => {
      set.headers['x-request-id'] = access.requestId(request);
      set.headers['cache-control'] = 'no-store';
      await access.admitWrite(request);
    })
    .onError({ as: 'global' }, createErrorHandler(!!deps.pool, access))
    .resolve({ as: 'local' }, async ({ request }) => ({
      actor: await access.requireActor(request),
      requestId: access.requestId(request),
    }))
    .post(
      '/api/v1/approvals/:id/actions/confirm',
      async ({ actor, params, body, requestId }) =>
        okEnvelope(await confirmApproval(operations, actor.ownerId, params.id, body), requestId),
      {
        parse,
        // Match the public controller's order: JSON, literal ID, then body schema.
        transform: ({ path, params }) => {
          params.id = literalUuidAt(path, 3, 'approval not found');
        },
        body: ConfirmBodySchema,
        response: responses(ConfirmResultSchema),
      },
    )
    .post(
      '/api/v1/tasks/:id/actions/cancel',
      async ({ actor, params, body, requestId }) =>
        okEnvelope(await requestCancel(operations, actor.ownerId, params.id, body), requestId),
      {
        parse,
        transform: ({ path, params }) => {
          params.id = literalUuidAt(path, 3, 'task not found');
        },
        body: CancelBodySchema,
        response: responses(CancelResultSchema),
      },
    );

  return async (request: Request): Promise<Response | null> => {
    if (request.method !== 'POST' || !reminderActionPath.test(new URL(request.url).pathname))
      return null;
    return actions.handle(request);
  };
}
