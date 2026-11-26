import type { ThreadEvent } from '@along/stream-protocol';
import type { ConversationDeps, StartResult } from '../agent/execution/contracts.js';
import { openBusinessRun } from '../agent/run/execute-turn.js';
import { stateConflict } from '../platform/errors.js';

export async function bindBusinessRun(deps: ConversationDeps, started: StartResult) {
  if (!started.context) throw stateConflict('run context missing');
  const business = await openBusinessRun(deps, started.context);
  const { restatement, wantsReminder, wantsCancel, cancellationTarget } = business;
  return {
    facts: { restatement, wantsReminder, wantsCancel, cancellationTarget },
    invoke: business.invoke,
    cancel: business.cancel,
    start: business.start,
    publish: (type: ThreadEvent['type'], payload: Record<string, unknown>) =>
      business.publish(type, payload),
  };
}
