import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_V1 } from '../src/fixtures/fixture-v1.js';
import { normalize } from '../src/normalize.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reverse clock', () => {
  it('fake system time and alien TZ do not move output', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('1999-01-01T00:00:00Z'));
    const spy = vi.spyOn(Date, 'now');
    const a = normalize('2026-10-17T09:20:00', 'Asia/Shanghai', 'none', FIXTURE_V1);
    expect(a).toEqual({
      kind: 'ok',
      fire_at_utc: '2026-10-17T01:20:00Z',
      offset_seconds: 28800,
      fold: 0,
      ruleset_id: 'FIXTURE_V1',
    });
    vi.setSystemTime(new Date('2099-12-31T23:59:59Z'));
    const b = normalize('2026-11-01T01:30:00', 'America/New_York', 'none', FIXTURE_V1);
    expect(b).toEqual({
      kind: 'error',
      error: 'AMBIGUOUS_LOCAL_TIME',
      candidates: [
        { fold_choice: 'first', offset_seconds: -14400, fire_at_utc: '2026-11-01T05:30:00Z' },
        { fold_choice: 'second', offset_seconds: -18000, fire_at_utc: '2026-11-01T06:30:00Z' },
      ],
      ruleset_id: 'FIXTURE_V1',
    });
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('Kiritimati wall time is stable', () => {
    const r = normalize('2026-10-17T15:20:00', 'Pacific/Kiritimati', 'none', FIXTURE_V1);
    expect(r).toEqual({
      kind: 'ok',
      fire_at_utc: '2026-10-17T01:20:00Z',
      offset_seconds: 50400,
      fold: 0,
      ruleset_id: 'FIXTURE_V1',
    });
  });
});
