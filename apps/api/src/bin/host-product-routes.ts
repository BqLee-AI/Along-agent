import { Elysia } from 'elysia';
import { createAccess } from '../http/access.js';
import type { AppDeps } from '../http/contracts.js';
import { createErrorHandler, failEnvelope, jsonResponse } from '../http/errors.js';
import { unmatchedError } from '../http/routing/fallback-controller.js';
import { httpStatusForError } from '@along/contracts';
import { approvalWriteScopes, createApprovalController } from '../features/approvals/controller.js';
import { botWriteScopes, createBotController } from '../features/bots/controller.js';
import { createBriefController } from '../features/brief/controller.js';
import { createMemoryController, memoryWriteScopes } from '../features/memory/controller.js';
import { createModelProviderController } from '../features/model-providers/http/controller.js';
import { createNewsController } from '../features/news-briefings/controller.js';
import { createWechatController } from '../features/news-briefings/wechat-controller.js';
import { createFeishuController } from '../features/office-connectors/controller.js';
import { createTaskController, taskWriteScopes } from '../features/tasks/controller.js';
import { loadTimeContext } from '../features/time/public.js';
import { createWorkspaceController } from '../features/workspaces/http/controller.js';

const summaryPath = '/api/v1/model-providers/actions/summarize-notes';
const productScopes = [
  '/api/v1/approvals',
  '/api/v1/document-approvals',
  '/api/v1/bots',
  '/api/v1/tasks',
  '/api/v1/memories',
  '/api/v1/office/feishu/bot',
  '/api/v1/channels/wechat',
  '/api/v1/news',
];
const writeScopes = [
  '/api/v1/channels/wechat',
  '/api/v1/news',
  ...approvalWriteScopes,
  ...taskWriteScopes,
  ...memoryWriteScopes,
  ...botWriteScopes,
];

function withinScope(path: string, scope: string) {
  return scope.endsWith('/')
    ? path.startsWith(scope)
    : path === scope || path.startsWith(`${scope}/`);
}

export function createHostProductRoutes(deps: AppDeps) {
  const access = createAccess(deps);
  const timeContext = deps.timeContext ?? loadTimeContext(deps.tzdbVersion);
  const app = new Elysia({ name: 'host-product', strictPath: true, normalize: false })
    .onRequest(async ({ request, set }) => {
      const id = access.requestId(request);
      set.headers['x-request-id'] = id;
      set.headers['cache-control'] = 'no-store';
      const pathname = new URL(request.url).pathname;
      const newsWrite =
        (request.method === 'PUT' && pathname === '/api/v1/news/subscription') ||
        (request.method === 'DELETE' && pathname === '/api/v1/channels/wechat');
      if (!newsWrite && request.method !== 'GET' && request.method !== 'POST') {
        const error = await unmatchedError(request, !!deps.pool, access);
        return jsonResponse(httpStatusForError(error.code), failEnvelope(error, id), id);
      }
      if (
        newsWrite ||
        (request.method === 'POST' &&
          (pathname === summaryPath || writeScopes.some((scope) => withinScope(pathname, scope))))
      )
        await access.admitWrite(request);
    })
    .onError({ as: 'global' }, createErrorHandler(!!deps.pool, access))
    .use(createApprovalController({ pool: deps.pool, timeContext }, access))
    .use(createBotController(deps.pool, access))
    .use(
      createBriefController(
        { pool: deps.pool, tzdbVersion: deps.tzdbVersion, timeContext },
        access,
      ),
    )
    .use(createTaskController({ pool: deps.pool }, access))
    .use(createWorkspaceController(access))
    .use(createMemoryController(deps.memoryService, access))
    .use(createFeishuController(deps.pool, access))
    .use(createNewsController(deps.pool, access))
    .use(createWechatController(deps.pool, access))
    .use(
      createModelProviderController(
        { pool: deps.pool, modelTransport: deps.modelTransport },
        access,
      ),
    );

  return async (request: Request): Promise<Response | null> => {
    const path = new URL(request.url).pathname;
    if (
      path !== summaryPath &&
      path !== '/api/v1/brief' &&
      path !== '/api/v1/workspaces' &&
      !productScopes.some((scope) => withinScope(path, scope))
    )
      return null;
    return app.handle(request);
  };
}
