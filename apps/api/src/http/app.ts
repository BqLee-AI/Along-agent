import { Elysia } from 'elysia';
import { createAccess, type HttpAccess } from './access.js';
import { createErrorHandler, failEnvelope, jsonResponse } from './errors.js';
import { unmatchedError } from './routing/fallback-controller.js';
import { httpStatusForError } from '@along/contracts';
import { createHealthController } from './health/controller.js';
import {
  createMeController,
  createAccountController,
} from '../features/identity/account/controller.js';
import { createBriefController } from '../features/brief/controller.js';
import { createWorkspaceController } from '../features/workspaces/http/controller.js';
import {
  createModelProviderController,
  modelProviderWriteScopes,
  modelSelectionWritePath,
} from '../features/model-providers/http/controller.js';
import { createApprovalController, approvalWriteScopes } from '../features/approvals/controller.js';
import { botWriteScopes, createBotController } from '../features/bots/controller.js';
import { createTaskController, taskWriteScopes } from '../features/tasks/controller.js';
import { createMemoryController, memoryWriteScopes } from '../features/memory/controller.js';
import { createFeishuController } from '../features/office-connectors/controller.js';
import {
  createConversationController,
  conversationWriteScopes,
} from '../features/conversations/controller.js';
import { loadTimeContext } from '../features/time/public.js';
import type { AppDeps } from './contracts.js';
export type { AppDeps } from './contracts.js';

async function unsupportedMethod(request: Request, hasPool: boolean, access: HttpAccess) {
  const error = await unmatchedError(request, hasPool, access);
  const id = access.requestId(request);
  return jsonResponse(httpStatusForError(error.code), failEnvelope(error, id), id);
}

export function createApp(deps: AppDeps) {
  const access = createAccess(deps);
  const timeContext = deps.timeContext ?? loadTimeContext(deps.tzdbVersion);
  const writeScopes = [
    ...modelProviderWriteScopes,
    ...approvalWriteScopes,
    ...taskWriteScopes,
    ...memoryWriteScopes,
    ...conversationWriteScopes,
    ...botWriteScopes,
  ];
  return (
    new Elysia({ name: 'along-api', strictPath: true, normalize: false })
      // Root-only onRequest runs before matching and parsing; it is never exported as a feature plugin.
      .onRequest(async ({ request, set }) => {
        set.headers['x-request-id'] = access.requestId(request);
        set.headers['cache-control'] = 'no-store';
        const pathname = new URL(request.url).pathname;
        if (request.method !== 'GET' && request.method !== 'POST')
          return unsupportedMethod(request, !!deps.pool, access);
        if (
          request.method === 'POST' &&
          (pathname === modelSelectionWritePath ||
            writeScopes.some((scope) =>
              scope.endsWith('/')
                ? pathname.startsWith(scope)
                : pathname === scope || pathname.startsWith(scope + '/'),
            ))
        )
          await access.admitWrite(request);
      })
      .onError({ as: 'global' }, createErrorHandler(!!deps.pool, access))
      .use(createHealthController(deps.pool, timeContext))
      .use(createMeController(access))
      .use(
        createBriefController(
          { pool: deps.pool, tzdbVersion: deps.tzdbVersion, timeContext },
          access,
        ),
      )
      .use(createWorkspaceController(access))
      .use(
        createModelProviderController(
          { pool: deps.pool, modelTransport: deps.modelTransport },
          access,
        ),
      )
      .use(
        createAccountController(
          {
            accountService: deps.accountService,
            invitedAccountService: deps.invitedAccountService,
            pool: deps.pool,
            timeContext,
          },
          access,
        ),
      )
      .use(createApprovalController({ pool: deps.pool, timeContext }, access))
      .use(createBotController(deps.pool, access))
      .use(createTaskController({ pool: deps.pool }, access))
      .use(createMemoryController(deps.memoryService, access))
      .use(createFeishuController(deps.pool, access))
      .use(
        createConversationController(
          {
            pool: deps.pool,
            timeContext,
            harness: deps.harness,
            routing: deps.routing,
            runDriver: deps.runDriver,
            modelTransport: deps.modelTransport,
          },
          access,
        ),
      )
  );
}
export type App = ReturnType<typeof createApp>;
