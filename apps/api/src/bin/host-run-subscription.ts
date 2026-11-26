import type { RunEventSink } from '../features/conversations/run-event-response.js';

export function createHostRunSubscription(produce: (sink: RunEventSink) => Promise<void>) {
  const abort = new AbortController();
  let done = false;
  let demand: ((value: unknown) => boolean) | undefined;
  let claimed = false;
  let wake: (() => void) | undefined;

  function emit(value: unknown): boolean {
    const reply = demand;
    demand = undefined;
    claimed = false;
    return reply?.(value) ?? false;
  }

  function close() {
    done = true;
    abort.abort();
    emit(null);
    wake?.();
  }

  const delivery = produce({
    signal: abort.signal,
    write: emit,
    async ready() {
      while (!done && !demand) {
        const { promise, resolve } = Promise.withResolvers<void>();
        wake = resolve;
        await promise;
        wake = undefined;
      }
      if (!done) claimed = true;
      return !done;
    },
  })
    .catch(() => {})
    .finally(close);

  function pull(reply: (value: unknown) => boolean): Promise<void> {
    if (done) {
      reply(null);
      return Promise.resolve();
    }
    if (demand) throw new Error('subscription pull already pending');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!claimed) emit('');
      }, 1000);
      demand = (value) => {
        clearTimeout(timer);
        try {
          return reply(value);
        } finally {
          resolve();
        }
      };
      wake?.();
    });
  }

  return {
    pull,
    close: async () => {
      close();
      await delivery;
    },
  };
}
