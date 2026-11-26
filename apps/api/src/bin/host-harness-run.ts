import { randomUUID } from 'node:crypto';
import { ApplicationError, stateConflict, validationError } from '../platform/errors.js';
import type {
  HarnessProcessServices,
  NativeHarnessOptions,
} from '../agent/harness/harness-process.js';
import { createHostHarnessExchange } from './host-harness-session.js';

function exited() {
  return new ApplicationError(502, 'HARNESS_EXITED', 'harness process exited unexpectedly');
}

export interface HostHarnessRun {
  id: string;
  run(options: NativeHarnessOptions): Promise<void>;
  compact: NonNullable<HarnessProcessServices['compactExchange']>;
  step(operation: string, input: unknown): Promise<unknown>;
  finish(): void;
}

export function createHostHarnessRun(): HostHarnessRun {
  const id = randomUUID();
  let finished = false;
  let attempt:
    | {
        exchange: ReturnType<typeof createHostHarnessExchange>;
        taken: boolean;
        settle: (error?: Error) => void;
      }
    | undefined;
  let compactWork:
    | {
        id: string;
        operation: 'assemble' | 'interpret';
        input: string;
        taken: boolean;
        resolve: (output: string) => void;
        reject: (error: unknown) => void;
      }
    | undefined;

  const compact: HostHarnessRun['compact'] = async (operation, input, signal) => {
    signal.throwIfAborted();
    if (finished || attempt || compactWork) throw stateConflict('native Compact unavailable');
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    compactWork = { id: randomUUID(), operation, input, taken: false, resolve, reject };
    try {
      return await promise;
    } finally {
      compactWork = undefined;
      signal.removeEventListener('abort', stop);
    }
  };

  async function run(options: NativeHarnessOptions): Promise<void> {
    if (finished || attempt || compactWork) throw stateConflict('native Run execution unavailable');
    const exchange = createHostHarnessExchange(options);
    if (options.signal.aborted) return;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const stop = () => resolve();
    options.signal.addEventListener('abort', stop, { once: true });
    attempt = { exchange, taken: false, settle: (error) => (error ? reject(error) : resolve()) };
    try {
      await promise;
    } finally {
      attempt = undefined;
      options.signal.removeEventListener('abort', stop);
    }
  }

  async function step(operation: string, input: unknown): Promise<unknown> {
    if (operation === 'next') {
      if (finished) return { status: 'done' };
      if (compactWork && !compactWork.taken) {
        compactWork.taken = true;
        return {
          status: 'compact',
          id: compactWork.id,
          operation: compactWork.operation,
          input: compactWork.input,
        };
      }
      if (!attempt || attempt.taken) return { status: 'pending' };
      attempt.taken = true;
      try {
        return { status: 'start', frame: await attempt.exchange.start() };
      } catch (error) {
        attempt?.settle(error instanceof Error ? error : exited());
        throw error;
      }
    }
    if (operation === 'abandon') {
      finish();
      return null;
    }
    if (operation === 'compact-result') {
      if (!input || typeof input !== 'object' || !('id' in input))
        throw validationError('invalid Compact result');
      if (compactWork?.taken && compactWork.id === input.id) {
        if ('output' in input && typeof input.output === 'string')
          compactWork.resolve(input.output);
        else compactWork.reject(exited());
      }
      return null;
    }
    if (!attempt?.taken) throw stateConflict('native attempt unavailable');
    if (operation === 'exchange') {
      if (typeof input !== 'string') throw validationError('native request frame required');
      const active = attempt;
      try {
        return await active.exchange.exchange(input);
      } catch (error) {
        active.settle(error instanceof Error ? error : exited());
        throw error;
      }
    }
    if (operation === 'exit') {
      try {
        if (input === 'HARNESS_UNAVAILABLE')
          throw new ApplicationError(503, input, 'harness unavailable');
        if (input === 'HARNESS_PROTOCOL_ERROR')
          throw new ApplicationError(502, input, 'harness protocol rejected');
        if (input === 'HARNESS_CONTEXT_LIMIT')
          throw new ApplicationError(422, input, 'harness context exceeds safe capacity');
        if (input !== 'ok') throw exited();
        attempt.exchange.finish();
        attempt.settle();
      } catch (error) {
        attempt.settle(error instanceof Error ? error : exited());
      }
      return null;
    }
    throw validationError('unknown native Run operation');
  }

  function finish() {
    finished = true;
    attempt?.settle(exited());
    compactWork?.reject(exited());
  }
  return { id, run, compact, step, finish };
}
