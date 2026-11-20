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
  ready: () => Promise<boolean>;
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
  let demand = false;
  let closed = false;
  const source = {
    start(controller: ReadableStreamDefaultController<Uint8Array>) {
      const sink: EventSink = {
        signal: abort.signal,
        write(event) {
          // A pull grants one handoff; never buffer a disclosure for a future read.
          if (closed || !demand) return false;
          demand = false;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          return true;
        },
        async ready() {
          if (closed || demand) return !closed;
          const { promise, resolve } = Promise.withResolvers<void>();
          wake = resolve;
          await promise;
          return !closed;
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
      demand = true;
      wake?.();
      wake = undefined;
    },
    cancel() {
      closed = true;
      abort.abort();
      wake?.();
      wake = undefined;
    },
  };
  const body = new ReadableStream(source, { highWaterMark: 0 });
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
        if (!(await sink.ready())) return;
        const delivered = await writeAuthorizedEvent(
          pool,
          actor.ownerId,
          async (item) => sink.write(item),
          event,
          actor.sessionId,
        );
        if (!delivered) return;
        afterSeq = event.seq;
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
        if (!(await sink.ready())) return;
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
    const write = Object.assign(async (event: ThreadEvent) => sink.write(event), {
      ready: sink.ready,
    });
    await executeRun(deps, started.context, write, sink.signal);
  });
}
