import { randomUUID } from 'node:crypto';
import type { ThreadEvent } from '@along/stream-protocol';
import { executeRuntimeCompact } from '../agent/compact/runtime-compact.js';
import { RunDriver } from '../agent/execution/driver/driver.js';
import { subscribeRun } from '../features/conversations/run-event-response.js';
import type { AppDeps } from '../http/contracts.js';
import { loadTimeContext } from '../features/time/public.js';
import { writeAuthorizedEvent } from '../features/conversations/public.js';
import { stateConflict, validationError } from '../platform/errors.js';
import { createHostAdmission } from './host-admission.js';
import { bindBusinessRun } from './host-business-run.js';
import { createHostHarnessRun } from './host-harness-run.js';

export function createHostBusinessCapability(deps: AppDeps) {
  const harnessRuns = new Map<string, ReturnType<typeof createHostHarnessRun>>();
  const admit = createHostAdmission(deps, (context) => {
    if (!(deps.runDriver instanceof RunDriver))
      throw stateConflict('native Run driver unavailable');
    const native = createHostHarnessRun();
    const execution = deps.runDriver.start(
      {
        pool: deps.pool,
        timeContext,
        harness: deps.harness,
        modelTransport: deps.modelTransport,
        routing: deps.routing,
        runDriver: deps.runDriver,
        runHarness: native.run,
      },
      context,
      executeRuntimeCompact,
    );
    harnessRuns.set(context.runId, native);
    void execution
      .finally(native.finish)
      .catch((error: unknown) => console.error('[host harness]', error));
    return undefined;
  });
  const timeContext = deps.timeContext ?? loadTimeContext(deps.tzdbVersion);
  const runs = new Map<
    string,
    {
      expires: ReturnType<typeof setTimeout>;
      operation: (name: string, input: unknown) => Promise<unknown>;
      close: () => Promise<void>;
    }
  >();
  async function open(request: Request) {
    const { actor, requestId, started } = await admit(request);
    const ids = { runId: started.runId, conversationId: started.conversationId };
    const native = started.serverOwned ? harnessRuns.get(started.runId) : undefined;
    const lease = randomUUID();
    let close: () => Promise<void>;
    let operation: (name: string, input: unknown) => Promise<unknown>;
    let facts: unknown;
    if (started.serverOwned) {
      harnessRuns.delete(started.runId);
      const stream = await subscribeRun(
        { pool: deps.pool, timeContext },
        actor,
        started.conversationId,
        started.runId,
        requestId,
        started.afterSeq ?? null,
      );
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      operation = async (name) => {
        if (name !== 'replay') throw validationError('expected Run event pull');
        const item = await reader.read();
        return item.done ? null : decoder.decode(item.value);
      };
      close = () => reader.cancel();
    } else if (started.replay) {
      let index = 0;
      const replay = started.replay;
      const pool = deps.pool;
      if (!pool) throw stateConflict('database unavailable');
      operation = async (name) => {
        if (name !== 'replay') throw validationError('expected replay pull');
        while (index < replay.length) {
          const next = replay[index++]!;
          let projected: ThreadEvent | undefined;
          await writeAuthorizedEvent(
            pool,
            actor.ownerId,
            async (event) => {
              projected = event;
              return true;
            },
            next,
            actor.sessionId,
          );
          if (projected) return projected;
        }
        return null;
      };
      close = async () => {};
    } else {
      const business = await bindBusinessRun({ ...deps, timeContext }, actor, started);
      facts = business.facts;
      let terminal = false;
      operation = async (name, input) => {
        if (name === 'start') return business.start();
        if (name === 'invoke') {
          if (input !== 'propose_task' && input !== 'request_cancel_task' && input !== 'list_tasks')
            throw validationError('invalid deterministic tool');
          return business.invoke(input);
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
          return event;
        }
        throw validationError('unknown deterministic operation');
      };
      close = async () => {
        if (!terminal) await business.cancel();
      };
    }
    const expires = setTimeout(() => {
      native?.finish();
      void dispose(lease).catch((error: unknown) => console.error('[host run] expiry', error));
    }, 300_000).unref();
    runs.set(lease, { expires, operation, close });
    if (native) nativeRuns.set(native.id, native);
    return {
      ...ids,
      lease,
      replay: !!started.replay,
      facts,
      subscription: !!started.serverOwned,
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

  async function step(lease: string, name: string, input: unknown) {
    if (name === 'close') {
      await dispose(lease);
      return null;
    }
    const state = runs.get(lease);
    if (!state) throw stateConflict('Run capability unavailable');
    return state.operation(name, input);
  }

  const nativeRuns = new Map<string, ReturnType<typeof createHostHarnessRun>>();
  async function harnessStep(id: string, operation: string, input: unknown) {
    const native = nativeRuns.get(id);
    if (!native) throw stateConflict('native Run unavailable');
    const result = await native.step(operation, input);
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
