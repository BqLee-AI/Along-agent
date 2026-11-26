import { startConversationRun, type ServerOwnedRunHandoff } from '../agent/run/admit-message.js';
import { SendMessageBodySchema } from '../features/conversations/public.js';
import { loadTimeContext } from '../features/time/public.js';
import { createAccess, idempotencyKeyOf } from '../http/access.js';
import type { AppDeps } from '../http/contracts.js';
import { validationError } from '../platform/errors.js';

export function createHostAdmission(deps: AppDeps, handoff?: ServerOwnedRunHandoff) {
  const access = createAccess(deps);
  const conversation = {
    pool: deps.pool,
    timeContext: deps.timeContext ?? loadTimeContext(deps.tzdbVersion),
    harness: deps.harness,
    routing: deps.routing,
    runDriver: deps.runDriver,
    modelTransport: deps.modelTransport,
  };

  return async function admit(request: Request) {
    const requestId = access.requestId(request);
    const actor = await access.requireActor(request);
    access.csrf(request, actor);
    const body = SendMessageBodySchema.safeParse(await access.json(request));
    if (!body.success) throw validationError('invalid request body');
    const started = await startConversationRun(
      conversation,
      actor.ownerId,
      requestId,
      body.data,
      idempotencyKeyOf(request),
      actor.sessionId,
      handoff,
    );
    return { actor, requestId, started };
  };
}
