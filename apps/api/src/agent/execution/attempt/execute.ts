import { httpStatusForError } from '@along/contracts';
import { THREAD_PROTOCOL_VERSION } from '@along/stream-protocol';
import { withTransaction } from '../../../db/transaction.js';
import {
  appendEvent,
  listRunEvents,
  lockRun,
  requirePool,
} from '../../../features/conversations/public.js';
import { ApplicationError } from '../../../platform/errors.js';
import { runNativeHarness } from '../../harness/harness-process.js';
import { commitTerminal } from '../result/commit.js';
import { createHarnessSession } from './session.js';
import type { ConversationDeps, EventWriter, RunContext } from '../contracts.js';
import { unavailable } from './context.js';
import { activeExecutions, withRunTransaction } from '../driver/ownership.js';

export async function executeAttempt(
  deps: ConversationDeps,
  context: RunContext,
  write: EventWriter,
  {
    signal,
    interruption,
    onDisconnect,
  }: {
    signal?: AbortSignal;
    interruption?: AbortSignal;
    onDisconnect?: () => Promise<unknown>;
  } = {},
): Promise<void> {
  const pool = requirePool(deps);
  if (!deps.harness) throw unavailable();
  const controller = new AbortController();
  const ownershipLost = () => controller.abort();
  context.ownership?.signal.addEventListener('abort', ownershipLost, { once: true });
  interruption?.addEventListener('abort', ownershipLost, { once: true });
  if (context.ownership?.signal.aborted || interruption?.aborted) controller.abort();
  activeExecutions.set(context.runId, controller);
  let cancellation: Promise<unknown> | undefined;
  let cancellationFailure: { error: unknown } | undefined;
  let cancellationProjected = false;
  let closeSession: (() => Promise<void>) | undefined;
  const inFlight = new Set<Promise<unknown>>();
  const disconnected = () => {
    cancellation ??= onDisconnect?.().catch((error: unknown) => {
      cancellationFailure = { error };
    });
  };
  signal?.addEventListener('abort', disconnected, { once: true });
  try {
    if (signal?.aborted) {
      disconnected();
      await cancellation;
      return;
    }
    const sessionWrite: EventWriter = async (event, authority) => {
      const open = await write(event, authority);
      if (open && event.type === 'thread.cancelled') cancellationProjected = true;
      if (!open) {
        disconnected();
        // The private publication transaction must release the Run before cancellation can lock it.
        if (authority !== 'held') await cancellation;
      }
      return open;
    };
    if (write.ready) sessionWrite.ready = write.ready;
    const session = await createHarnessSession(
      deps,
      context,
      sessionWrite,
      controller.signal,
      context.ownership ? 'subscription' : 'inline',
    );
    closeSession = session.close;
    if (session.start.snapshot === null) {
      const event = await withRunTransaction(pool, context.ownership, async (client) => {
        await lockRun(client, context);
        return appendEvent(client, context, 'thread.started', {
          conversation_id: context.conversationId,
          run_id: context.runId,
          stream_protocol_version: THREAD_PROTOCOL_VERSION,
          ruleset_id: context.timeContext.ruleset_id,
          tzdb_version: context.timeContext.tzdb_version,
        });
      });
      if (!(await write(event))) {
        disconnected();
        await cancellation;
        return;
      }
    }
    await runNativeHarness({
      services: deps.harness,
      start: session.start,
      signal: controller.signal,
      guardStart: session.guardStart,
      guardReply: session.guardReply,
      detachOnAbort: !!context.ownership,
      onExit: session.close,
      handleRequest: (request) => {
        const pending = (async () => {
          // No next native action may overtake a disconnect's durable decision.
          await cancellation;
          if (cancellationFailure) throw cancellationFailure.error;
          return session.handleRequest(request);
        })();
        if (context.ownership) {
          inFlight.add(pending);
          void pending.then(
            () => inFlight.delete(pending),
            () => inFlight.delete(pending),
          );
        }
        return pending;
      },
    });
    // An external revocation stops the native process without throwing. Still
    // account for a disabled owner's running attempt while ownership is held;
    // a committed cancellation already wins the terminal-state check.
    if (interruption?.aborted) throw new Error('server-owned execution interrupted');
  } catch (error) {
    await cancellation;
    try {
      const failed = await withRunTransaction(pool, context.ownership, async (client) => {
        // Revocation rejects execution, but may not prevent recording its failure.
        await lockRun(client, context, true, false);
        const code = error instanceof ApplicationError ? error.errorCode : 'INTERNAL_ERROR';
        return commitTerminal(client, context, 'failed', {
          conversation_id: context.conversationId,
          run_id: context.runId,
          error: {
            code,
            message: error instanceof ApplicationError ? error.message : '原生执行失败。',
            http_status: error instanceof ApplicationError ? httpStatusForError(error.code) : 500,
          },
        });
      });
      // Durable accounting does not authorize disclosure to the old connection.
      // Reuse the ordinary owner/Run read gate after the terminal commit.
      await withTransaction(pool, (client) => lockRun(client, context, false));
      await write(failed);
    } catch {
      // Stale/terminal authority wins; revoked readers receive no failure content.
    }
  } finally {
    try {
      await closeSession?.();
      signal?.removeEventListener('abort', disconnected);
      context.ownership?.signal.removeEventListener('abort', ownershipLost);
      interruption?.removeEventListener('abort', ownershipLost);
      if (activeExecutions.get(context.runId) === controller)
        activeExecutions.delete(context.runId);
      // Project the committed stop before waiting for already-dispatched effects.
      if (controller.signal.aborted && !signal?.aborted && !cancellationProjected) {
        const events = await listRunEvents(pool, context.ownerId, context.runId);
        const cancelled = events.find((event) => event.type === 'thread.cancelled');
        if (cancelled) await write(cancelled);
      }
    } finally {
      // Keep the execution slot and control pool alive through late accounting.
      await Promise.allSettled(inFlight);
    }
  }
}
