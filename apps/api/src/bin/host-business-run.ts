import type { ThreadEvent } from '@along/stream-protocol';
import type { Actor } from '../features/identity/public.js';
import { writeAuthorizedEvent } from '../features/conversations/public.js';
import type { ConversationDeps, StartResult } from '../agent/execution/contracts.js';
import { openBusinessRun } from '../agent/run/execute-turn.js';
import { stateConflict } from '../platform/errors.js';

export async function bindBusinessRun(deps: ConversationDeps, actor: Actor, started: StartResult) {
  const pool = deps.pool;
  if (!pool || !started.context) throw stateConflict('run context missing');
  const business = await openBusinessRun(deps, started.context);
  const { restatement, wantsReminder, wantsCancel, cancellationTarget } = business;
  async function project(event: ThreadEvent) {
    let result: ThreadEvent | undefined;
    await writeAuthorizedEvent(
      pool!,
      actor.ownerId,
      async (authorized) => {
        result = authorized;
        return true;
      },
      event,
    );
    if (!result) throw stateConflict('run event no longer available');
    return result;
  }
  return {
    facts: { restatement, wantsReminder, wantsCancel, cancellationTarget },
    invoke: business.invoke,
    cancel: business.cancel,
    start: async () => project(await business.start()),
    publish: async (type: ThreadEvent['type'], payload: Record<string, unknown>) =>
      project(await business.publish(type, payload)),
  };
}
