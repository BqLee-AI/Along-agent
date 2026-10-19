import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../src/index.js';

describe('stream-protocol', () => {
  it('holds exactly the seven frozen event words', () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        'cancel_requested',
        'cancelled',
        'created',
        'fired',
        'missed',
        'reconciliation_run',
        'scheduled',
      ].sort(),
    );
  });

  it('rejects saved/schedule_confirmed', () => {
    expect(EVENT_TYPES).not.toContain('saved');
    expect(EVENT_TYPES).not.toContain('schedule_confirmed');
  });
});
