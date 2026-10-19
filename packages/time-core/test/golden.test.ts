import { describe, expect, it } from 'vitest';
import { FIXTURE_V1 } from '../src/fixtures/fixture-v1.js';
import { normalize } from '../src/normalize.js';
import type { TimeRuleset } from '../src/types.js';

describe('golden four baselines', () => {
  it('B1 straight Shanghai', () => {
    const r = normalize('2026-10-17T09:20:00', 'Asia/Shanghai', 'none', FIXTURE_V1);
    expect(r).toEqual({
      kind: 'ok',
      fire_at_utc: '2026-10-17T01:20:00Z',
      offset_seconds: 28800,
      fold: 0,
      ruleset_id: 'FIXTURE_V1',
    });
  });

  it('B2 nonexistent spring forward', () => {
    const r = normalize('2026-03-08T02:30:00', 'America/New_York', 'none', FIXTURE_V1);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error).toBe('NONEXISTENT_LOCAL_TIME');
  });

  it('B3 ambiguous fall back unchosen', () => {
    const r = normalize('2026-11-01T01:30:00', 'America/New_York', 'none', FIXTURE_V1);
    expect(r).toEqual({
      kind: 'error',
      error: 'AMBIGUOUS_LOCAL_TIME',
      candidates: [
        { fold_choice: 'first', offset_seconds: -14400, fire_at_utc: '2026-11-01T05:30:00Z' },
        { fold_choice: 'second', offset_seconds: -18000, fire_at_utc: '2026-11-01T06:30:00Z' },
      ],
      ruleset_id: 'FIXTURE_V1',
    });
  });

  it('B4 ambiguous chosen second', () => {
    const r = normalize('2026-11-01T01:30:00', 'America/New_York', 'second', FIXTURE_V1);
    expect(r).toEqual({
      kind: 'ok',
      fire_at_utc: '2026-11-01T06:30:00Z',
      offset_seconds: -18000,
      fold: 1,
      ruleset_id: 'FIXTURE_V1',
    });
  });

  it('2027 spring date set also holds', () => {
    const r = normalize('2027-03-14T02:30:00', 'America/New_York', 'none', FIXTURE_V1);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error).toBe('NONEXISTENT_LOCAL_TIME');
    const a = normalize('2027-11-07T01:30:00', 'America/New_York', 'first', FIXTURE_V1);
    expect(a).toEqual({
      kind: 'ok',
      fire_at_utc: '2027-11-07T05:30:00Z',
      offset_seconds: -14400,
      fold: 0,
      ruleset_id: 'FIXTURE_V1',
    });
  });
  it('unknown zone and missing ruleset', () => {
    const u = normalize('2026-10-17T09:20:00', 'Mars/Olympus', 'none', FIXTURE_V1);
    expect(u.kind).toBe('error');
    const empty = {} as unknown as TimeRuleset;
    const t = normalize('2026-10-17T09:20:00', 'Asia/Shanghai', 'none', empty);
    expect(t).toEqual({ kind: 'error', error: 'TZDB_UNAVAILABLE' });
  });
});
