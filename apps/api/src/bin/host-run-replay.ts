import type { ThreadEvent } from '@along/stream-protocol';
import { getRunView } from '../agent/run/public.js';
import type { ConversationDeps, StartResult } from '../agent/execution/contracts.js';
import { withTransaction } from '../db/transaction.js';
import {
  listConversationEvents,
  requirePool,
  writeAuthorizedEvent,
} from '../features/conversations/public.js';
import { lockViewerAccess, type Actor } from '../features/identity/public.js';
import { unauthorized, validationError } from '../platform/errors.js';

/** One guarded disclosure handoff per pull. The host chooses cursor and drain mode. */
export function bindRunReplay(deps: ConversationDeps, actor: Actor, run: StartResult) {
  const pool = requirePool(deps);
  const { ownerId, sessionId } = actor;
  const { conversationId, runId } = run;
  const limit = 200;
  let page: ThreadEvent[] = [];
  let offset = 0;
  let previous: number | null | undefined;

  return async (operation: string, afterSeq: unknown, reply: (value: unknown) => boolean) => {
    if (
      (operation !== 'poll' && operation !== 'drain') ||
      (afterSeq !== null &&
        (typeof afterSeq !== 'number' || !Number.isSafeInteger(afterSeq) || afterSeq < 0))
    )
      throw validationError('invalid Run replay pull');
    if (afterSeq !== previous || offset === page.length) {
      page = await listConversationEvents(pool, {
        ownerId,
        conversationId,
        runId,
        afterSeq,
        limit,
        includePendingDisclosures: sessionId !== null,
      });
      offset = 0;
    }
    if (offset < page.length) {
      const event = page[offset++]!;
      previous = event.seq;
      let handedOff = false;
      const open = await writeAuthorizedEvent(
        pool,
        ownerId,
        async (item) => {
          handedOff = true;
          return reply({ status: 'event', seq: item.seq, json: JSON.stringify(item) });
        },
        event,
        sessionId,
      );
      if (open && !handedOff) reply({ status: 'withheld', seq: event.seq });
      return;
    }
    if (operation === 'drain') {
      reply({ status: 'done' });
      return;
    }
    const view = await getRunView(deps, ownerId, conversationId, runId);
    await withTransaction(pool, async (client) => {
      if (!(await lockViewerAccess(client, ownerId, sessionId))) throw unauthorized();
    });
    reply({ status: view.status === 'running' ? 'pending' : 'settled' });
  };
}
