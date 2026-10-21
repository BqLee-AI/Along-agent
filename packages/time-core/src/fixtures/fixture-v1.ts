// FIXTURE_V1 frozen ruleset content (docs/demo/time-core-golden-cases.md 前置).
// Covers design/05 §4 2027 dates and golden-doc 2026 dates (both spring sets).
import type { TimeRuleset } from '../types.js';
import { freezeValue } from '../immutable.js';

export const FIXTURE_V1: TimeRuleset = freezeValue({
  ruleset_id: 'FIXTURE_V1',
  tzdb_version: 'fixture-v1',
  zones: {
    'Asia/Shanghai': {
      base_offset_seconds: 28800,
      coverage: {
        wall_start: '2026-01-01T00:00:00',
        wall_end: '2028-01-01T00:00:00',
        utc_start: '2025-12-31T16:00:00Z',
        utc_end: '2027-12-31T16:00:00Z',
      },
      transitions: [],
    },
    'America/New_York': {
      base_offset_seconds: -18000,
      coverage: {
        wall_start: '2026-01-01T00:00:00',
        wall_end: '2028-01-01T00:00:00',
        utc_start: '2026-01-01T05:00:00Z',
        utc_end: '2028-01-01T05:00:00Z',
      },
      transitions: [
        { at_utc: '2026-03-08T07:00:00Z', offset_seconds: -14400 },
        { at_utc: '2026-11-01T06:00:00Z', offset_seconds: -18000 },
        { at_utc: '2027-03-14T07:00:00Z', offset_seconds: -14400 },
        { at_utc: '2027-11-07T06:00:00Z', offset_seconds: -18000 },
      ],
    },
    'Pacific/Kiritimati': {
      base_offset_seconds: 50400,
      coverage: {
        wall_start: '2026-01-01T00:00:00',
        wall_end: '2028-01-01T00:00:00',
        utc_start: '2025-12-31T10:00:00Z',
        utc_end: '2027-12-31T10:00:00Z',
      },
      transitions: [],
    },
  },
});
