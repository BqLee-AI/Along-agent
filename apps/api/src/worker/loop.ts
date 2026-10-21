// Worker loop: single-tick scheduler for the `worker`/`all` roles. Ticks run
// phases in strict order — cancel -> schedule -> claim -> send -> ack ->
// missed — each phase guarded by a serial tick lock plus per-row try/catch
// so one bad row never breaks the loop cycle. Main owns the scheduler pool;
// this loop owns a separate, single-connection notification receive pool.
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { createPool, type Pool } from '../db/pool.js';
import { OUTBOX_POLL_INTERVAL_MS } from '@along/scheduler-core';
import { runCancelPhase } from '../modules/tasks/scheduler/cancel-phase.js';
import { runSchedulePhase } from '../modules/tasks/scheduler/schedule.js';
import { runClaimPhase } from '../modules/tasks/scheduler/claim.js';
import { runSendPhase } from '../modules/tasks/scheduler/send.js';
import { runAckPhase } from '../modules/tasks/scheduler/ack.js';
import { runMissedPhase } from '../modules/tasks/scheduler/missed.js';
import { createLocalInAppProvider } from '../modules/notifications/service.js';

const schedulerTicks = channel('along.scheduler.tick');

export interface WorkerLoopOptions {
  pool?: Pool | null;
  intervalMs?: number;
  workerId?: string;
  onError?: (phase: string, err: unknown) => void;
}

export interface WorkerLoopHandle {
  stop: () => Promise<void>;
  tick: () => Promise<void>;
  workerId: string;
}

export function startWorkerLoop(options: WorkerLoopOptions = {}): WorkerLoopHandle {
  const pool = options.pool ?? null;
  const intervalMs = options.intervalMs ?? OUTBOX_POLL_INTERVAL_MS;
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const onError = options.onError ?? (() => undefined);
  // pg hides explicit passwords from enumeration on Pool.options.
  const receivePool = pool
    ? createPool({ ...pool.options, password: pool.options.password, max: 1 })
    : null;
  const provider = receivePool ? createLocalInAppProvider(receivePool) : null;
  let activeTick: Promise<void> | null = null;
  let stopped = false;
  let stopping: Promise<void> | null = null;

  async function runTick(): Promise<void> {
    if (!pool || !provider) return;
    let success = true;
    async function runPhase(name: string, fn: () => Promise<unknown>): Promise<void> {
      try {
        await fn();
      } catch (err) {
        success = false;
        onError(name, err);
      }
    }
    await runPhase('cancel', () => runCancelPhase(pool));
    await runPhase('schedule', () => runSchedulePhase(pool));
    await runPhase('claim', () => runClaimPhase(pool, workerId));
    await runPhase('send', () => runSendPhase(pool, provider));
    await runPhase('ack', () => runAckPhase(pool));
    await runPhase('missed', () => runMissedPhase(pool));
    if (schedulerTicks.hasSubscribers) schedulerTicks.publish({ workerId, success });
  }

  function tick(): Promise<void> {
    // Serial guard: a slow tick never overlaps the next one.
    if (activeTick || stopped) return Promise.resolve();
    activeTick = runTick().finally(() => {
      activeTick = null;
    });
    return activeTick;
  }

  // Keep worker-only roles alive even when every PG connection is idle.
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    stop: () => {
      if (!stopping) {
        stopped = true;
        clearInterval(timer);
        stopping = (async () => {
          try {
            await activeTick;
          } finally {
            await receivePool?.end();
          }
        })();
      }
      return stopping;
    },
    tick,
    workerId,
  };
}
