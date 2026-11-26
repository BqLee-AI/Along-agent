import { randomUUID } from 'node:crypto';
import type { ThreadEvent } from '@along/stream-protocol';
import type { ConversationDeps } from '../agent/execution/contracts.js';
import { executeRun } from '../agent/run/public.js';
import { RunDriver } from '../agent/execution/driver/driver.js';
import type { AppDeps } from '../http/contracts.js';
import { loadTimeContext } from '../features/time/public.js';
import { writeAuthorizedEvent } from '../features/conversations/public.js';
import { ApplicationError, stateConflict, validationError } from '../platform/errors.js';
import { bindRunReplay } from './host-run-replay.js';
import { createHostConversationOperations } from './host-conversation-operations.js';
import { bindBusinessRun } from './host-business-run.js';
import { createHostHarnessRun, type HostHarnessRun } from './host-harness-run.js';
import { createHostRunSubscription } from './host-run-subscription.js';

type Reply = (value: unknown) => boolean;

export function createHostBusinessCapability(deps: AppDeps) {
  const nativeRuns = new Map<string, HostHarnessRun>();
  const dispatch = createHostConversationOperations(deps);
  const timeContext = deps.timeContext ?? loadTimeContext(deps.tzdbVersion);
  const runs = new Map<
    string,
    {
      expires: ReturnType<typeof setTimeout>;
      operation: (name: string, input: unknown, reply: Reply) => Promise<void>;
      close: () => Promise<void>;
    }
  >();
  async function open(request: Request, entry: string) {
    let native: HostHarnessRun | undefined;
    function allocateNative() {
      const run = createHostHarnessRun();
      nativeRuns.set(run.id, run);
      native = run;
      return run;
    }
    function finishNative(run: HostHarnessRun) {
      run.finish();
      // Retain the completion long enough for the native consumer's final poll.
      setTimeout(() => nativeRuns.delete(run.id), 10_000).unref();
    }
    const driver = deps.runDriver;
    const domain: ConversationDeps = {
      ...deps,
      timeContext,
      runDriver:
        driver instanceof RunDriver
          ? {
              acquire: driver.acquire.bind(driver),
              release: driver.release.bind(driver),
              start(executionDeps, context, compact) {
                const run = allocateNative();
                try {
                  const execution = driver.start(
                    {
                      ...executionDeps,
                      harness: executionDeps.harness
                        ? { ...executionDeps.harness, compactExchange: run.compact }
                        : executionDeps.harness,
                      runHarness: run.run,
                    },
                    context,
                    compact,
                  );
                  void execution
                    .finally(() => finishNative(run))
                    .catch((error: unknown) => console.error('[host harness]', error));
                } catch (error) {
                  nativeRuns.delete(run.id);
                  throw error;
                }
              },
            }
          : driver,
    };
    const result = await dispatch(domain, entry, request);
    if ('data' in result) return { data: result.data, native: native?.id };
    const { actor, stream: started } = result;
    const ids = { runId: started.runId, conversationId: started.conversationId };
    const lease = randomUUID();
    let close: () => Promise<void>;
    let operation: (name: string, input: unknown, reply: Reply) => Promise<void>;
    let facts: unknown;
    const subscribed = !!started.serverOwned;
    const streamed = !!started.replay || started.context?.execution === 'harness';
    if (subscribed) {
      const pull = bindRunReplay(domain, actor, started);
      operation = async (name, input, reply) => {
        try {
          await pull(name, input, reply);
        } catch (error) {
          // A stream has already been opened; a failed disclosure check closes it.
          if (
            error instanceof ApplicationError &&
            (error.errorCode === 'FORBIDDEN' || error.errorCode === 'UNAUTHENTICATED')
          ) {
            reply({ status: 'done' });
            return;
          }
          throw error;
        }
      };
      close = async () => {};
    } else if (streamed) {
      const { replay, context } = started;
      const subscription = createHostRunSubscription(async (sink) => {
        if (replay) {
          const pool = deps.pool;
          if (!pool) throw stateConflict('database unavailable');
          for (const event of replay) {
            if (!(await sink.ready())) return;
            const delivered = await writeAuthorizedEvent(
              pool,
              actor.ownerId,
              async (item) => sink.write(item),
              event,
              actor.sessionId,
            );
            if (!delivered) return;
          }
        } else {
          if (!context) throw stateConflict('Run context missing');
          const run = allocateNative();
          const write = Object.assign(async (event: ThreadEvent) => sink.write(event), {
            ready: sink.ready,
          });
          try {
            await executeRun({ ...domain, runHarness: run.run }, context, write, sink.signal);
          } finally {
            finishNative(run);
          }
        }
      });
      operation = async (name, _input, reply) => {
        if (name !== 'replay') throw validationError('expected Run event pull');
        await subscription.pull(reply);
      };
      close = subscription.close;
    } else {
      const pool = deps.pool;
      if (!pool) throw stateConflict('database unavailable');
      const business = await bindBusinessRun({ ...deps, timeContext }, started);
      const publish = (event: ThreadEvent, reply: Reply) =>
        writeAuthorizedEvent(pool, actor.ownerId, async (item) => reply(item), event);
      facts = business.facts;
      let terminal = false;
      operation = async (name, input, reply) => {
        if (name === 'start') {
          await publish(await business.start(), reply);
          return;
        }
        if (name === 'invoke') {
          if (input !== 'propose_task' && input !== 'request_cancel_task' && input !== 'list_tasks')
            throw validationError('invalid deterministic tool');
          reply(await business.invoke(input));
          return;
        }
        if (name === 'publish') {
          if (
            !input ||
            typeof input !== 'object' ||
            !('type' in input) ||
            !('payload' in input) ||
            !input.payload ||
            typeof input.payload !== 'object' ||
            Array.isArray(input.payload)
          )
            throw validationError('invalid event input');
          const type = input.type;
          if (
            type !== 'message.delta' &&
            type !== 'card.proposed' &&
            type !== 'approval_required' &&
            type !== 'thread.completed' &&
            type !== 'thread.failed'
          )
            throw validationError('invalid deterministic event');
          const event = await business.publish(type, input.payload as Record<string, unknown>);
          terminal = type === 'thread.completed' || type === 'thread.failed';
          await publish(event, reply);
          return;
        }
        throw validationError('unknown deterministic operation');
      };
      close = async () => {
        if (!terminal) await business.cancel();
      };
    }
    const expires = setTimeout(() => {
      void dispose(lease).catch((error: unknown) => console.error('[host run] expiry', error));
    }, 300_000).unref();
    runs.set(lease, { expires, operation, close });
    return {
      ...ids,
      lease,
      facts,
      streamed,
      subscribed,
      afterSeq: started.afterSeq ?? null,
      native: native?.id,
    };
  }

  async function dispose(lease: string) {
    const state = runs.get(lease);
    if (!state) return;
    runs.delete(lease);
    clearTimeout(state.expires);
    await state.close();
  }

  async function step(lease: string, name: string, input: unknown, reply: Reply) {
    if (name === 'close') {
      await dispose(lease);
      reply(null);
      return;
    }
    const state = runs.get(lease);
    if (!state) throw stateConflict('Run capability unavailable');
    await state.operation(name, input, reply);
  }

  async function harnessStep(id: string, operation: string, input: unknown) {
    const native = nativeRuns.get(id);
    if (!native) throw stateConflict('native Run unavailable');
    const result = await native.step(operation, input);
    if (operation === 'abandon') nativeRuns.delete(id);
    if (
      operation === 'next' &&
      result &&
      typeof result === 'object' &&
      'status' in result &&
      result.status === 'done'
    )
      nativeRuns.delete(id);
    return result;
  }
  return {
    open,
    step,
    harnessStep,
    close: () => {
      for (const native of nativeRuns.values()) native.finish();
      nativeRuns.clear();
      return Promise.allSettled([...runs.keys()].map(dispose));
    },
  };
}
