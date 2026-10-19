// Gate phase helpers: trigger门禁三查 (three checks) shared by send.
// 1. task row matches (id + fire_at + version), 2. state is scheduled,
// 3. schedule_receipt binds to this task. Cancel-pending cancels block;
// past-window rows report MISSED (the missed phase owns the transition).
import { evaluateGate, type GateBlockReason } from '@along/scheduler-core';
import type { SchedulerTaskRow } from './scheduler-repository.js';

export type { GateBlockReason };

export interface GateDecision {
  allowed: boolean;
  reason: GateBlockReason | null;
}

export function decideSendGate(args: {
  task: SchedulerTaskRow | null;
  expectedStateVersion: number;
  scheduleReceipt: string;
  nowMs: number;
}): GateDecision {
  if (!args.task) return { allowed: false, reason: 'NOT_FOUND' };
  const verdict = evaluateGate(
    {
      found: true,
      state: args.task.state,
      stateVersion: args.task.state_version,
      fireAtMs: args.task.fire_at_utc.getTime(),
      scheduleReceipt: args.task.schedule_receipt,
    },
    {
      taskId: args.task.id,
      expectedStateVersion: args.expectedStateVersion,
      scheduleReceipt: args.scheduleReceipt,
    },
    args.nowMs,
  );
  if (verdict.ok) return { allowed: true, reason: null };
  return { allowed: false, reason: verdict.reason };
}
