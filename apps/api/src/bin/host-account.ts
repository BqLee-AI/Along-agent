import { httpStatusForError } from '@along/contracts';
import { Elysia } from 'elysia';
import { createAccountController, createMeController } from '../features/identity/account/controller.js';
import { createModelProviderController } from '../features/model-providers/http/controller.js';
import { isModelProviderPath } from '../features/model-providers/http/path.js';
import type { TimeContext } from '../features/time/public.js';
import { createAccess } from '../http/access.js';
import type { AppDeps } from '../http/contracts.js';
import { createErrorHandler, failEnvelope, jsonResponse } from '../http/errors.js';
import { unmatchedError } from '../http/routing/fallback-controller.js';
import { finiteRequest } from './finite-http.js';

export function createHostAccount(
  deps: Pick<AppDeps, 'pool' | 'accountService' | 'invitedAccountService' | 'modelTransport'> & {
    timeContext: TimeContext;
  },
) {
  const access = createAccess(deps);
  const hasPool = !!deps.pool;
  const app = new Elysia({ name: 'host-account', strictPath: true, normalize: false })
    .onRequest(async ({ request, set }) => {
      const id = access.requestId(request);
      set.headers['x-request-id'] = id;
      set.headers['cache-control'] = 'no-store';
      if (request.method !== 'GET' && request.method !== 'POST') {
        const error = await unmatchedError(request, hasPool, access);
        return jsonResponse(httpStatusForError(error.code), failEnvelope(error, id), id);
      }
      if (request.method === 'POST' && isModelProviderPath(new URL(request.url).pathname))
        await access.admitWrite(request);
    })
    .onError({ as: 'global' }, createErrorHandler(hasPool, access))
    .use(createMeController(access))
    .use(createAccountController(deps, access))
    .use(createModelProviderController(deps, access));

  return (request: Request): Response | Promise<Response> | null => {
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/model-providers/actions/summarize-notes') return null;
    if (path === '/api/v1/me' || path.startsWith('/api/v1/auth/') || isModelProviderPath(path))
      return app.handle(finiteRequest(request));
    return null;
  };
}
