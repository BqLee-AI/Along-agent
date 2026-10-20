import { describe, expect, it } from 'bun:test';
import { ALIAS_TABLE_V1, classifyEntry } from '../src/entry.js';
import { FIXTURE_V1 } from '../src/fixtures/fixture-v1.js';

const S = 'Asia/Shanghai';

describe('entry 年月日 colon minutes (P1)', () => {
  it('keeps minutes with a daypart', () => {
    const c = classifyEntry({
      text: '2026年10月17日晚上9:20',
      anchorReceivedAtUtc: '2026-10-16T15:20:00Z',
      confirmedTz: S,
      ruleset: FIXTURE_V1,
    });
    expect(c.class).toBe('normalize_ok');
    expect(c.wall_time).toBe('2026-10-17T21:20:00');
  });

  it('normalizes 24h colon form without a daypart', () => {
    const c = classifyEntry({
      text: '2026年10月17日 9:20',
      anchorReceivedAtUtc: '2026-10-16T15:20:00Z',
      confirmedTz: S,
      ruleset: FIXTURE_V1,
    });
    expect(c.class).toBe('normalize_ok');
    expect(c.wall_time).toBe('2026-10-17T09:20:00');
  });
});

describe('entry 月日24:00 anchor guard (P2)', () => {
  it('asks YEAR_MISSING when the resolved date is before the anchor date', () => {
    const c = classifyEntry({
      text: '10月16日24:00',
      anchorReceivedAtUtc: '2026-12-19T16:00:00Z',
      confirmedTz: S,
      ruleset: FIXTURE_V1,
    });
    expect(c.class).toBe('clarify');
    expect(c.reason).toBe('YEAR_MISSING');
  });

  it('still normalizes when the resolved date is not in the past', () => {
    const c = classifyEntry({
      text: '10月16日24:00',
      anchorReceivedAtUtc: '2026-10-16T15:20:00Z',
      confirmedTz: S,
      ruleset: FIXTURE_V1,
    });
    expect(c.class).toBe('normalize_ok');
    expect(c.wall_time).toBe('2026-10-17T00:00:00');
  });
});

describe('entry alias table version (P2)', () => {
  it('pins ALIAS_TABLE_V1 on results', () => {
    expect(ALIAS_TABLE_V1.version).toBe('ALIAS_TABLE_V1');
    const c = classifyEntry({
      text: '北京时间 9:20',
      anchorReceivedAtUtc: '2026-10-16T15:20:00Z',
      confirmedTz: S,
      ruleset: FIXTURE_V1,
    });
    expect(c.class).toBe('normalize_ok');
    expect(c.alias_table_version).toBe('ALIAS_TABLE_V1');
    expect(c.timezone_id).toBe('Asia/Shanghai');
  });
});
