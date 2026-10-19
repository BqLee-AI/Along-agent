// scheduler-core: pure scheduling predicates and idempotency-key builders.
// No I/O, no Date.now inside predicates (callers pass `nowMs`); DB clock is
// authoritative at the repository layer, these functions only encode policy.

// Fire window: a due task may fire while now is within [fireAt, fireAt + 15min].
// The 15-minute upper bound is inclusive (design/08 §5).
export const FIRE_WINDOW_MS = 15 * 60 * 1000;

// Send backoff between delivery attempts (design/08 §4: 1min after first, 5min after).
export const SEND_RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000] as const;
export const MAX_SEND_ATTEMPTS = 3;

// ACK_UNKNOWN re-check schedule (design/08 §4: 30s / 2min / 5min, then
// persistent reconciliation marker). Index = ack_check_no already performed.
export const ACK_CHECK_DELAYS_MS = [30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000] as const;
export const MAX_ACK_CHECKS = 3;

// Lease time-to-live for a claimed task (worker/loop ownership).
export const LEASE_TTL_MS = 2 * 60 * 1000;

// Outbox polling interval for the worker loop (design/08 §1: 30s start value).
export const OUTBOX_POLL_INTERVAL_MS = 30 * 1000;

// Local schedule-registry receipt prefix: schedule receipts issued by the
// schedule phase take the form `sched:<taskId>`.
export const SCHEDULE_RECEIPT_PREFIX = 'sched:';

export function scheduleReceiptFor(taskId: string): string {
  return `${SCHEDULE_RECEIPT_PREFIX}${taskId}`;
}

export function cancelReceiptFor(taskId: string): string {
  return `cancel:${taskId}`;
}

// Idempotency keys carried on outbox commands (design/08 §1:贯穿 outbox→
// schedule→send; same key retried without re-asking the user).
export function scheduleKeyFor(taskId: string): string {
  return `schedule:${taskId}`;
}

export function sendKeyFor(taskId: string, fireAtIso: string): string {
  return `send:${taskId}:${fireAtIso}`;
}

export function cancelKeyFor(taskId: string, key: string): string {
  return `cancel:${taskId}:${key}`;
}

/** True when `nowMs` is inside the inclusive 15-minute fire window. */
export function isWithinFireWindow(fireAtMs: number, nowMs: number): boolean {
  return nowMs >= fireAtMs && nowMs - fireAtMs <= FIRE_WINDOW_MS;
}

/** True when the fire window has fully elapsed (missed, never refire). */
export function isPastFireWindow(fireAtMs: number, nowMs: number): boolean {
  return nowMs - fireAtMs > FIRE_WINDOW_MS;
}

/**
 * Backoff before the next send attempt. `attemptNo` is 1-based (the attempt
 * that just ran). Returns null when no further delivery attempt is allowed.
 */
export function backoffMsForAttempt(attemptNo: number): number | null {
  if (attemptNo < 1 || attemptNo >= MAX_SEND_ATTEMPTS) return null;
  return SEND_RETRY_DELAYS_MS[attemptNo - 1] ?? null;
}

/**
 * Delay before the next ACK_UNKNOWN reconciliation check. `checkNo` is the
 * 0-based count of checks already performed. Returns null when the checks
 * are exhausted (caller marks persistent reconciliation state).
 */
export function ackDelayForCheck(checkNo: number): number | null {
  if (checkNo < 0 || checkNo >= MAX_ACK_CHECKS) return null;
  return ACK_CHECK_DELAYS_MS[checkNo] ?? null;
}

export type GateVerdict = { ok: true } | { ok: false; reason: GateBlockReason };

export type GateBlockReason =
  | 'NOT_FOUND'
  | 'VERSION_MISMATCH'
  | 'NOT_SCHEDULED'
  | 'CANCEL_PENDING'
  | 'CANCELLED'
  | 'RECEIPT_MISMATCH'
  | 'MISSED';

export interface GateSnapshot {
  found: boolean;
  state: string;
  stateVersion: number;
  fireAtMs: number;
  scheduleReceipt: string | null;
}

export interface GateClaim {
  taskId: string;
  expectedStateVersion: number;
  scheduleReceipt: string;
}

/**
 * Trigger gate, three checks (design/08 §3): row matches
 * (id + fire_at + version), state is scheduled, receipt binds to this task.
 * Cancel-pending tasks are always blocked; cancelled tasks stay blocked.
 * A fully elapsed fire window reports MISSED (caller marks missed, no refire).
 */
export function evaluateGate(snapshot: GateSnapshot, claim: GateClaim, nowMs: number): GateVerdict {
  if (!snapshot.found) return { ok: false, reason: 'NOT_FOUND' };
  if (snapshot.state === 'cancelled') return { ok: false, reason: 'CANCELLED' };
  if (snapshot.state === 'cancel_pending') return { ok: false, reason: 'CANCEL_PENDING' };
  if (snapshot.state !== 'scheduled') return { ok: false, reason: 'NOT_SCHEDULED' };
  if (snapshot.stateVersion !== claim.expectedStateVersion) {
    return { ok: false, reason: 'VERSION_MISMATCH' };
  }
  if (snapshot.scheduleReceipt !== claim.scheduleReceipt) {
    return { ok: false, reason: 'RECEIPT_MISMATCH' };
  }
  void claim.taskId;
  if (isPastFireWindow(snapshot.fireAtMs, nowMs)) {
    return { ok: false, reason: 'MISSED' };
  }
  return { ok: true };
}
