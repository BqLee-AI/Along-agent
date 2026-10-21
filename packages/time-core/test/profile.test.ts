import { describe, expect, it } from 'bun:test';
import { FIXTURE_V1 } from '../src/fixtures/fixture-v1.js';
import { ALIAS_TABLE_V1, classifyEntry } from '../src/entry.js';
import { normalize } from '../src/normalize.js';
import { isSupportedRuleset, utcInCoverage } from '../src/profile.js';
import type { FoldChoice, TimeRuleset } from '../src/types.js';

const EDGES = [
  [
    'Asia/Shanghai',
    '2025-12-31T15:59:59Z',
    '2025-12-31T16:00:00Z',
    '2027-12-31T15:59:59Z',
    '2027-12-31T16:00:00Z',
  ],
  [
    'Pacific/Kiritimati',
    '2025-12-31T09:59:59Z',
    '2025-12-31T10:00:00Z',
    '2027-12-31T09:59:59Z',
    '2027-12-31T10:00:00Z',
  ],
  [
    'America/New_York',
    '2026-01-01T04:59:59Z',
    '2026-01-01T05:00:00Z',
    '2028-01-01T04:59:59Z',
    '2028-01-01T05:00:00Z',
  ],
] as const;

describe('finite production profile', () => {
  for (const [zone, before, start, last, end] of EDGES) {
    it(`${zone}: local and UTC coverage are half open at second precision`, () => {
      expect(normalize('2025-12-31T23:59:59', zone, 'none', FIXTURE_V1)).toMatchObject({
        error: 'TZDB_UNAVAILABLE',
      });
      expect(normalize('2026-01-01T00:00:00', zone, 'none', FIXTURE_V1)).toMatchObject({
        kind: 'ok',
        fire_at_utc: start,
      });
      expect(normalize('2027-12-31T23:59:59', zone, 'none', FIXTURE_V1)).toMatchObject({
        kind: 'ok',
        fire_at_utc: last,
      });
      expect(normalize('2028-01-01T00:00:00', zone, 'none', FIXTURE_V1)).toMatchObject({
        error: 'TZDB_UNAVAILABLE',
      });
      expect([before, start, last, end].map((utc) => utcInCoverage(FIXTURE_V1, zone, utc))).toEqual(
        [false, true, true, false],
      );
      for (const anchor of [before, end]) {
        expect(
          classifyEntry({
            aliases: ALIAS_TABLE_V1,
            text: '明天 9:20',
            anchorReceivedAtUtc: anchor,
            receivedAtUtc: anchor,
            confirmedTz: zone,
            ruleset: FIXTURE_V1,
          }),
        ).toMatchObject({ class: 'error', reason: 'TZDB_UNAVAILABLE' });
      }
    });
  }

  it('does not sort or repair damaged rules', () => {
    const ny = FIXTURE_V1.zones['America/New_York'];
    const variants: TimeRuleset[] = [
      { ...FIXTURE_V1, tzdb_version: '2024a' },
      {
        ...FIXTURE_V1,
        zones: {
          ...FIXTURE_V1.zones,
          'America/New_York': { ...ny, transitions: [...ny.transitions].reverse() },
        },
      },
      {
        ...FIXTURE_V1,
        zones: {
          ...FIXTURE_V1.zones,
          'America/New_York': { ...ny, transitions: ny.transitions.slice(1) },
        },
      },
      {
        ...FIXTURE_V1,
        zones: {
          ...FIXTURE_V1.zones,
          'America/New_York': { ...ny, base_offset_seconds: -18000.5 },
        },
      },
      { ...FIXTURE_V1, zones: {} },
    ];
    for (const rules of variants) {
      expect(isSupportedRuleset(rules)).toBe(false);
      expect(normalize('2026-10-17T09:20:00', 'Asia/Shanghai', 'none', rules)).toMatchObject({
        error: 'TZDB_UNAVAILABLE',
      });
    }
    expect(normalize('2026-10-17T09:20:00', 'toString', 'none', FIXTURE_V1)).toMatchObject({
      error: 'UNKNOWN_TIMEZONE',
    });
  });

  const transitions: [string, string, FoldChoice, string, number][] = [
    ['2026-03-08', '01:59:59', 'none', '2026-03-08T06:59:59Z', -18000],
    ['2026-03-08', '03:00:00', 'none', '2026-03-08T07:00:00Z', -14400],
    ['2026-03-08', '03:00:01', 'none', '2026-03-08T07:00:01Z', -14400],
    ['2026-11-01', '01:59:59', 'first', '2026-11-01T05:59:59Z', -14400],
    ['2026-11-01', '01:00:00', 'second', '2026-11-01T06:00:00Z', -18000],
    ['2026-11-01', '01:00:01', 'second', '2026-11-01T06:00:01Z', -18000],
    ['2027-03-14', '01:59:59', 'none', '2027-03-14T06:59:59Z', -18000],
    ['2027-03-14', '03:00:00', 'none', '2027-03-14T07:00:00Z', -14400],
    ['2027-03-14', '03:00:01', 'none', '2027-03-14T07:00:01Z', -14400],
    ['2027-11-07', '01:59:59', 'first', '2027-11-07T05:59:59Z', -14400],
    ['2027-11-07', '01:00:00', 'second', '2027-11-07T06:00:00Z', -18000],
    ['2027-11-07', '01:00:01', 'second', '2027-11-07T06:00:01Z', -18000],
  ];
  for (const [date, time, fold, utc, offset] of transitions) {
    it(`NY transition ${utc}`, () => {
      expect(normalize(`${date}T${time}`, 'America/New_York', fold, FIXTURE_V1)).toMatchObject({
        kind: 'ok',
        fire_at_utc: utc,
        offset_seconds: offset,
      });
    });
  }
});
