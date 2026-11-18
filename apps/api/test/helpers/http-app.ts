import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../../src/http/app.js';
import { handleRequest as handleSocketRequest } from '../../src/http/transport/handler.js';
import type { AppDeps } from '../../src/http/contracts.js';
import { createConfiguredAccountService } from '../../src/bootstrap/identity.js';
import { createInvitedAccountService } from '../../src/features/identity/public.js';
import { createMemoryService } from '../../src/features/memory/public.js';
import { conversationMemorySources } from '../../src/features/conversations/public.js';
import { attachConnection } from '../../src/http/transport/metadata.js';
import { toWebRequest } from '../../src/http/transport/request.js';
import { writeWebResponse } from '../../src/http/transport/response.js';

/** Test composition uses the same real services as bootstrap, without starting workers. */
export function httpTestDeps(deps: AppDeps): AppDeps {
  const pool = deps.pool;
  return {
    ...deps,
    accountService:
      deps.accountService ?? (pool ? createConfiguredAccountService(pool) : undefined),
    invitedAccountService:
      deps.invitedAccountService ?? (pool ? createInvitedAccountService(pool) : undefined),
    memoryService:
      deps.memoryService ??
      (pool ? createMemoryService({ pool, sources: conversationMemorySources }) : undefined),
  };
}
/** Existing in-process fixtures now execute real Fetch Requests through Elysia.
 * Real Node socket fixtures still execute the production transport unchanged.
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  dependencies: AppDeps,
): Promise<void> {
  const deps = httpTestDeps(dependencies);
  if (req.socket && typeof req.socket.setNoDelay === 'function')
    return handleSocketRequest(req, res, deps);
  const request = toWebRequest(req, new URL(req.url ?? '/', 'http://localhost'));
  attachConnection(request, {
    remoteAddress: req.socket?.remoteAddress ?? null,
    localAddress: req.socket?.localAddress ?? null,
    encrypted: !!req.socket && 'encrypted' in req.socket && req.socket.encrypted === true,
    ...(deps.resolveActor
      ? { resolveActor: (_input, context) => deps.resolveActor!(req, context) }
      : {}),
  });
  await writeWebResponse(await createApp(deps).handle(request), res);
}
