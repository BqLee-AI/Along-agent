import type { ThreadEvent } from '@along/stream-protocol';
import { withTransaction } from '../../db/transaction.js';
import { unauthorized } from '../../platform/errors.js';
import { lockViewerAccess, type Actor } from '../identity/public.js';
import type { ConversationDeps, StartResult } from '../../agent/runtime/contracts.js';
import { getRunView, executeRun } from '../../agent/operations/public.js';
import { listConversationEvents } from './run/repository.js';
import { writeAuthorizedEvent } from './run/stream-authorization.js';

type EventSink = {
  signal: AbortSignal;
  write: (event: ThreadEvent) => boolean;
  ready: () => Promise<void>;
};

function eventStreamResponse(
  requestId: string,
  conversationId: string,
  runId: string,
  produce: (sink: EventSink) => Promise<void>,
): Response {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let wake: (() => void) | undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const sink: EventSink = {
        signal: abort.signal,
        write(event) {
          if (closed) return false;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          return true;
        },
        async ready() {
          if (closed || (controller.desiredSize ?? 0) > 0) return;
          const { promise, resolve } = Promise.withResolvers<void>();
          wake = resolve;
          await promise;
        },
      };
      void produce(sink)
        .catch(() => {})
        .finally(() => {
          if (!closed) {
            closed = true;
            controller.close();
          }
          wake?.();
          wake = undefined;
        });
    },
    pull() {
      wake?.();
      wake = undefined;
    },
    cancel() {
      closed = true;
      abort.abort();
      wake?.();
      wake = undefined;
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-request-id': requestId,
      'x-conversation-id': conversationId,
      'x-run-id': runId,
    },
  });
}

// A socket can pause a subscriber, but never while an authorization transaction is held.
export async function subscribeRun(
  deps: ConversationDeps,
  actor: Actor,
  conversationId: string,
  runId: string,
  requestId: string,
  afterSeq: number | null,
): Promise<Response> {
  if (!deps.pool) throw new Error('database unavailable');
  const pool = deps.pool;
  await getRunView(deps, actor.ownerId, conversationId, runId);
  return eventStreamResponse(requestId, conversationId, runId, async (sink) => {
    let finalDrain = false;
    while (!sink.signal.aborted) {
      const events = await listConversationEvents(pool, {
        ownerId: actor.ownerId,
        conversationId,
        runId,
        limit: 200,
        afterSeq,
        includePendingDisclosures: actor.sessionId !== null,
      });
      for (const event of events) {
        const delivered = await writeAuthorizedEvent(
          pool,
          actor.ownerId,
          async (item) => sink.write(item),
          event,
          actor.sessionId,
        );
        if (!delivered) return;
        afterSeq = event.seq;
        await sink.ready();
        if (sink.signal.aborted) return;
      }
      if (events.length === 200) continue;
      if (finalDrain) return;
      const view = await getRunView(deps, actor.ownerId, conversationId, runId);
      if (view.status !== 'running') {
        finalDrain = true;
        continue;
      }
      await withTransaction(pool, async (client) => {
        if (!(await lockViewerAccess(client, actor.ownerId, actor.sessionId))) throw unauthorized();
      });
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(done, 500);
      function done() {
        clearTimeout(timer);
        sink.signal.removeEventListener('abort', done);
        resolve();
      }
      sink.signal.addEventListener('abort', done, { once: true });
      if (sink.signal.aborted) done();
      await promise;
    }
  });
}

export async function streamRun(
  deps: ConversationDeps,
  started: StartResult,
  actor: Actor,
  requestId: string,
): Promise<Response> {
  if ('serverOwned' in started && started.serverOwned === true) {
    const afterSeq =
      'afterSeq' in started && typeof started.afterSeq === 'number' ? started.afterSeq : null;
    return subscribeRun(deps, actor, started.conversationId, started.runId, requestId, afterSeq);
  }
  return eventStreamResponse(requestId, started.conversationId, started.runId, async (sink) => {
    if (started.replay) {
      if (!deps.pool) throw new Error('database unavailable');
      for (const event of started.replay) {
        // Wait outside the transaction; authorize again at each handoff.
        await sink.ready();
        if (sink.signal.aborted) return;
        const delivered = await writeAuthorizedEvent(
          deps.pool,
          actor.ownerId,
          async (item) => sink.write(item),
          event,
          actor.sessionId,
        );
        if (!delivered) return;
      }
      return;
    }
    if (!started.context) throw new Error('run context missing');
    await executeRun(deps, started.context, async (event) => sink.write(event), sink.signal);
  });
}
