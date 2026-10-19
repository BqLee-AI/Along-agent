// Worker loop: single-tick scheduler for the `worker`/`all` roles. Ticks run
// phases in strict order — cancel -> schedule -> claim -> send -> ack ->
// missed — each phase guarded by a serial tick lock plus per-row try/catch
// so one bad row never breaks the loop cycle. Pool is injected by main.ts;
// the loop never creates its own pool (one pool per process).
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { OUTBOX_POLL_INTERVAL_MS } from '@along/scheduler-core';
import { runCancelPhase } from '../modules/tasks/scheduler/cancel-phase.js';
import { runSchedulePhase } from '../modules/tasks/scheduler/schedule.js';
import { runClaimPhase } from '../modules/tasks/scheduler/claim.js';
import { runSendPhase } from '../modules/tasks/scheduler/send.js';
import { runAckPhase } from '../modules/tasks/scheduler/ack.js';
import { runMissedPhase } from '../modules/tasks/scheduler/missed.js';

export interface WorkerLoopOptions {
  pool?: Pool | null;
  intervalMs?: number;
  workerId?: string;
  onError?: (phase: string, err: unknown) => void;
}

export interface WorkerLoopHandle {
  stop: () => void;
  tick: () => Promise<void>;
  workerId: string;
}

export function startWorkerLoop(options: WorkerLoopOptions = {}): WorkerLoopHandle {
  const pool = options.pool ?? null;
  const intervalMs = options.intervalMs ?? OUTBOX_POLL_INTERVAL_MS;
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const onError = options.onError ?? (() => undefined);
  let ticking = false;
  let stopped = false;

  async function runPhase(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      onError(name, err);
    }
  }

  async function tick(): Promise<void> {
    // Serial guard: a slow tick never overlaps the next one.
    if (ticking || stopped) return;
    ticking = true;
    try {
      if (!pool) return;
      await runPhase('cancel', () => runCancelPhase(pool));
      await runPhase('schedule', () => runSchedulePhase(pool));
      await runPhase('claim', () => runClaimPhase(pool, workerId));
      await runPhase('send', () => runSendPhase(pool));
      await runPhase('ack', () => runAckPhase(pool));
      await runPhase('missed', () => runMissedPhase(pool));
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tick,
    workerId,
  };
}
