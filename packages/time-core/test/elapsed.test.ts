import { describe, expect, it } from 'bun:test';
import { addElapsed, FIXTURE_V1, utcToLocal } from '../src/index.js';

describe('strict elapsed arithmetic', () => {
  it('adds exact seconds to the supplied UTC anchor across calendar boundaries', () => {
    expect(addElapsed('2024-02-28T23:59:59Z', 62)).toBe('2024-02-29T00:01:01Z');
    expect(addElapsed('1969-12-31T23:59:59Z', 1)).toBe('1970-01-01T00:00:00Z');
    expect(addElapsed('0000-01-01T00:00:00Z', 0)).toBe('0000-01-01T00:00:00Z');
    expect(addElapsed('9999-12-31T23:59:58Z', 1)).toBe('9999-12-31T23:59:59Z');
  });

  it('rejects invalid anchors, fractional precision, invalid durations and overflow', () => {
    for (const anchor of [
      '2026-02-29T00:00:00Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00+00:00',
      '2026-01-01T00:00:60Z',
      '2026-01-01T00:00:00',
    ]) {
      expect(addElapsed(anchor, 1)).toBeNull();
    }
    for (const seconds of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(addElapsed('2026-01-01T00:00:00Z', seconds)).toBeNull();
    }
    expect(addElapsed('9999-12-31T23:59:59Z', 1)).toBeNull();
  });
});

describe('UTC to local conversion', () => {
  it('preserves the instant and fold across a DST fallback', () => {
    expect(utcToLocal('2026-11-01T05:30:00Z', 'America/New_York', FIXTURE_V1)).toMatchObject({
      kind: 'ok',
      wall_time: '2026-11-01T01:30:00',
      offset_seconds: -14400,
      fold: 0,
    });
    expect(utcToLocal('2026-11-01T06:30:00Z', 'America/New_York', FIXTURE_V1)).toMatchObject({
      kind: 'ok',
      wall_time: '2026-11-01T01:30:00',
      offset_seconds: -18000,
      fold: 1,
    });
    expect(utcToLocal('2026-03-08T07:00:00Z', 'America/New_York', FIXTURE_V1)).toMatchObject({
      kind: 'ok',
      wall_time: '2026-03-08T03:00:00',
      offset_seconds: -14400,
      fold: 0,
    });
  });

  it('does not invent rules or accept noncanonical UTC', () => {
    expect(utcToLocal('2026-11-01T05:30:00.000Z', 'America/New_York', FIXTURE_V1)).toEqual({
      kind: 'error',
      error: 'INVALID_UTC',
    });
    expect(utcToLocal('2026-11-01T05:30:00Z', 'Unknown/Zone', FIXTURE_V1)).toEqual({
      kind: 'error',
      error: 'UNKNOWN_TIMEZONE',
    });
    expect(utcToLocal('9999-01-01T00:00:00Z', 'America/New_York', FIXTURE_V1)).toEqual({
      kind: 'error',
      error: 'TZDB_UNAVAILABLE',
    });
    expect(
      utcToLocal('2026-11-01T05:30:00Z', 'America/New_York', {
        ...FIXTURE_V1,
        ruleset_id: 'invalid',
      }),
    ).toEqual({ kind: 'error', error: 'TZDB_UNAVAILABLE' });
  });
});
