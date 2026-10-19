import { describe, expect, it } from 'vitest';
import {
  ACK_CHECK_DELAYS_MS,
  FIRE_WINDOW_MS,
  MAX_ACK_CHECKS,
  MAX_SEND_ATTEMPTS,
  ackDelayForCheck,
  backoffMsForAttempt,
  cancelReceiptFor,
  evaluateGate,
  isPastFireWindow,
  isWithinFireWindow,
  scheduleKeyFor,
  scheduleReceiptFor,
  sendKeyFor,
} from '../src/index.js';

const FIRE_AT = Date.parse('2026-10-17T01:20:00.000Z');

function scheduled(overrides: Record<string, unknown> = {}) {
  return {
    found: true,
    state: 'scheduled',
    stateVersion: 3,
    fireAtMs: FIRE_AT,
    scheduleReceipt: scheduleReceiptFor('task-1'),
    ...overrides,
  };
}

function claim(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task-1',
    expectedStateVersion: 3,
    scheduleReceipt: scheduleReceiptFor('task-1'),
    ...overrides,
  };
}

describe('fire window (15min, inclusive boundary)', () => {
  it('fires at the exact instant and at the 15-minute edge', () => {
    expect(isWithinFireWindow(FIRE_AT, FIRE_AT)).toBe(true);
    expect(isWithinFireWindow(FIRE_AT, FIRE_AT + FIRE_WINDOW_MS)).toBe(true);
  });

  it('rejects before fire and after the window', () => {
    expect(isWithinFireWindow(FIRE_AT, FIRE_AT - 1)).toBe(false);
    expect(isWithinFireWindow(FIRE_AT, FIRE_AT + FIRE_WINDOW_MS + 1)).toBe(false);
    expect(isPastFireWindow(FIRE_AT, FIRE_AT + FIRE_WINDOW_MS)).toBe(false);
    expect(isPastFireWindow(FIRE_AT, FIRE_AT + FIRE_WINDOW_MS + 1)).toBe(true);
  });
});

describe('send backoff (2 attempts: 1min, 5min)', () => {
  it('backs off 1min then 5min, then stops', () => {
    expect(backoffMsForAttempt(1)).toBe(60 * 1000);
    expect(backoffMsForAttempt(2)).toBe(5 * 60 * 1000);
    expect(backoffMsForAttempt(3)).toBeNull();
    expect(backoffMsForAttempt(0)).toBeNull();
    expect(MAX_SEND_ATTEMPTS).toBe(3);
  });
});

describe('ack re-check schedule (30s / 2min / 5min)', () => {
  it('spaces checks then exhausts', () => {
    expect(ackDelayForCheck(0)).toBe(30 * 1000);
    expect(ackDelayForCheck(1)).toBe(2 * 60 * 1000);
    expect(ackDelayForCheck(2)).toBe(5 * 60 * 1000);
    expect(ackDelayForCheck(3)).toBeNull();
    expect(MAX_ACK_CHECKS).toBe(ACK_CHECK_DELAYS_MS.length);
  });
});

describe('receipt and idempotency keys', () => {
  it('binds receipts to the task id', () => {
    expect(scheduleReceiptFor('task-1')).toBe('sched:task-1');
    expect(cancelReceiptFor('task-1')).toBe('cancel:task-1');
    expect(scheduleKeyFor('task-1')).toBe('schedule:task-1');
    expect(sendKeyFor('task-1', '2026-10-17T01:20:00.000Z')).toBe(
      'send:task-1:2026-10-17T01:20:00.000Z',
    );
  });
});

describe('evaluateGate (three checks)', () => {
  it('passes when id, version, state and receipt all line up', () => {
    expect(evaluateGate(scheduled(), claim(), FIRE_AT + 1000)).toEqual({ ok: true });
  });

  it('blocks missing rows, version drift and receipt mismatch', () => {
    expect(evaluateGate(scheduled({ found: false }), claim(), FIRE_AT)).toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
    expect(evaluateGate(scheduled({ stateVersion: 4 }), claim(), FIRE_AT)).toEqual({
      ok: false,
      reason: 'VERSION_MISMATCH',
    });
    expect(evaluateGate(scheduled({ scheduleReceipt: 'sched:other' }), claim(), FIRE_AT)).toEqual({
      ok: false,
      reason: 'RECEIPT_MISMATCH',
    });
  });

  it('blocks non-scheduled states without claiming delivery', () => {
    for (const [state, reason] of [
      ['saved', 'NOT_SCHEDULED'],
      ['pending_schedule', 'NOT_SCHEDULED'],
      ['fired', 'NOT_SCHEDULED'],
      ['missed', 'NOT_SCHEDULED'],
      ['cancel_pending', 'CANCEL_PENDING'],
      ['cancelled', 'CANCELLED'],
    ] as const) {
      expect(evaluateGate(scheduled({ state }), claim(), FIRE_AT)).toEqual({
        ok: false,
        reason,
      });
    }
  });

  it('reports MISSED past the window instead of firing', () => {
    expect(evaluateGate(scheduled(), claim(), FIRE_AT + FIRE_WINDOW_MS + 1)).toEqual({
      ok: false,
      reason: 'MISSED',
    });
  });
});
