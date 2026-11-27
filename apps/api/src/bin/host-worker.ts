import { createPool, type Pool } from '../db/pool.js';
import { createLocalInAppProvider, type InAppProvider } from '../features/notifications/public.js';
import { runIdentityMailTick } from '../features/identity/public.js';
import { runNewsTick } from '../features/news-briefings/worker.js';
import type { TimeContext } from '../features/time/public.js';
import {
  runAckPhase,
  runCancelPhase,
  runClaimPhase,
  runMissedPhase,
  runSchedulePhase,
  runSendPhase,
} from '../features/tasks/public.js';

type PhaseRunner = (pool: Pool, provider: InAppProvider, workerId: string) => Promise<unknown>;

const phases: Partial<Record<string, PhaseRunner>> = {
  cancel: runCancelPhase,
  schedule: runSchedulePhase,
  claim: (pool, _provider, workerId) => runClaimPhase(pool, workerId),
  send: (pool, provider) => runSendPhase(pool, provider),
  ack: (pool) => runAckPhase(pool),
  missed: (pool) => runMissedPhase(pool),
};

export function createHostWorker(pool: Pool | null, time: TimeContext) {
  // pg hides explicit passwords from enumeration on Pool.options.
  const receivePool = pool
    ? createPool({ ...pool.options, password: pool.options.password, max: 1 })
    : null;
  const provider = receivePool ? createLocalInAppProvider(receivePool) : null;
  let activePhase: Promise<unknown> | null = null;
  let activeMail: Promise<unknown> | null = null;
  let activeNews: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;

  async function runPhase(phase: string, workerId: string): Promise<void> {
    if (phase === 'news') {
      if (stopping) throw new Error('host worker is stopping');
      if (!pool) return;
      if (activeNews) throw new Error('host news phase already active');
      activeNews = runNewsTick(pool, time);
      try {
        await activeNews;
      } finally {
        activeNews = null;
      }
      return;
    }
    if (phase === 'identity-mail') {
      if (stopping) throw new Error('host worker is stopping');
      if (!pool) return;
      if (activeMail) throw new Error('host mail phase already active');
      activeMail = runIdentityMailTick(pool);
      try {
        await activeMail;
      } finally {
        activeMail = null;
      }
      return;
    }
    const run = Object.hasOwn(phases, phase) ? phases[phase] : undefined;
    if (!run) throw new Error('unknown host worker phase');
    if (stopping) throw new Error('host worker is stopping');
    if (!pool || !provider) return;
    // An HTTP timeout may abandon a request before its database phase finishes.
    if (activePhase) throw new Error('host worker phase already active');
    activePhase = run(pool, provider, workerId);
    try {
      await activePhase;
    } finally {
      activePhase = null;
    }
  }

  function stop(): Promise<void> {
    stopping ??= (async () => {
      // A phase failure is reported to its own caller; only pool close can fail shutdown.
      await Promise.allSettled([activePhase, activeMail, activeNews]);
      await receivePool?.end();
    })();
    return stopping;
  }

  return { runPhase, stop };
}
