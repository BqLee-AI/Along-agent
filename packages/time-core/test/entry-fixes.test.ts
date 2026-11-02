import { describe, expect, it } from 'bun:test';
import { ALIAS_TABLE_V1, classifyEntry } from '../src/entry.js';
import { FIXTURE_V1 } from '../src/fixtures/fixture-v1.js';

const S = 'Asia/Shanghai';

describe('entry 年月日 colon minutes (P1)', () => {
  it('keeps minutes with a daypart', () => {
    const c = classifyEntry({
      aliases: ALIAS_TABLE_V1,
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
      aliases: ALIAS_TABLE_V1,
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
      aliases: ALIAS_TABLE_V1,
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
      aliases: ALIAS_TABLE_V1,
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
      aliases: ALIAS_TABLE_V1,
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

describe('entry Chinese numeral reminder clocks', () => {
  const classifyReminder = (text: string) =>
    classifyEntry({
      aliases: ALIAS_TABLE_V1,
      text,
      anchorReceivedAtUtc: '2026-10-17T01:00:00Z',
      receivedAtUtc: '2026-10-17T01:00:00Z',
      confirmedTz: S,
      ruleset: FIXTURE_V1,
      requireCompleteReminder: true,
    });

  it.each([
    ['今天下午三点二十提醒我喝水', '2026-10-17T15:20:00'],
    ['今天下午三点二十分提醒我喝水', '2026-10-17T15:20:00'],
    ['今天下午两点半提醒我喝水', '2026-10-17T14:30:00'],
    ['今天下午十五点二十分提醒我喝水', '2026-10-17T15:20:00'],
    ['今天上午十点零五分提醒我喝水', '2026-10-17T10:05:00'],
    ['今天晚上十一点五十九分提醒我喝水', '2026-10-17T23:59:00'],
    ['今天下午3点二十分提醒我喝水', '2026-10-17T15:20:00'],
    ['今天下午三点20分提醒我喝水', '2026-10-17T15:20:00'],
    ['2026年10月17日下午三点二十分提醒我喝水', '2026-10-17T15:20:00'],
  ])('normalizes the actual clock in %s', (text, wallTime) => {
    const result = classifyReminder(text);
    expect(result.class).toBe('normalize_ok');
    expect(result.wall_time).toBe(wallTime);
    expect(result.timezone_id).toBe(S);
  });

  it.each([
    '今天下午三点二十提醒我',
    '今天下午三点二十分提醒我',
    '今天下午两点半提醒我',
    '2026年10月17日下午三点二十分提醒我',
  ])('does not count the original time fragment as reminder content: %s', (text) => {
    const result = classifyReminder(text);
    expect(result.class).toBe('clarify');
    expect(result.reason).toBe('CONTENT_MISSING');
  });

  it.each([
    '今天三点提醒我喝水',
    '今天三点二十分提醒我喝水',
    '2026年10月17日三点二十分提醒我喝水',
    '2026年10月17日3点20分提醒我喝水',
  ])('still asks for a daypart in %s', (text) => {
    const result = classifyReminder(text);
    expect(result.class).toBe('clarify');
    expect(result.reason).toBe('DAYPART_MISSING');
  });

  it('still requires a confirmed timezone for a Chinese clock', () => {
    expect(
      classifyEntry({
        aliases: ALIAS_TABLE_V1,
        text: '今天下午三点二十分提醒我喝水',
        anchorReceivedAtUtc: '2026-10-17T01:00:00Z',
        confirmedTz: '',
        ruleset: FIXTURE_V1,
        requireCompleteReminder: true,
      }),
    ).toMatchObject({ class: 'clarify', reason: 'TIMEZONE_MISSING', phrase_key: 'ASK_TIMEZONE' });
  });

  it('does not infer a date from the anchor for a Chinese reminder clock', () => {
    expect(classifyReminder('下午三点二十分提醒我喝水')).toMatchObject({
      class: 'clarify',
      reason: 'DATE_MISSING',
      phrase_key: 'ASK_DATE',
    });
  });

  it.each([
    '今天下午二十五点二十分提醒我喝水',
    '今天午夜二十五点二十分提醒我喝水',
    '今天下午三点六十分提醒我喝水',
    '今天下午三点一百二十分提醒我喝水',
    '今天下午一百三点二十分提醒我喝水',
    '今天下午三三点二十分提醒我喝水',
    '今天下午三点二三分提醒我喝水',
  ])('does not accept a partial or out-of-range numeral in %s', (text) => {
    const result = classifyReminder(text);
    expect(result.class).toBe('clarify');
    expect(result.reason).toBe('DAYPART_MISSING');
  });

  it('keeps rejecting fuzzy time qualifiers', () => {
    const result = classifyReminder('今天下午三点二十左右提醒我喝水');
    expect(result.class).toBe('reject');
    expect(result.reason).toBe('FUZZY_RANGE');
  });

  it.each([
    ['今天下午3点20分提醒我喝水', '2026-10-17T15:20:00'],
    ['今天15:20提醒我喝水', '2026-10-17T15:20:00'],
    ['2026-10-17 15:20提醒我喝水', '2026-10-17T15:20:00'],
    ['今天下午三点二十分提醒我买二十三瓶水', '2026-10-17T15:20:00'],
  ])('preserves existing formats and unrelated numeral content: %s', (text, wallTime) => {
    const result = classifyReminder(text);
    expect(result.class).toBe('normalize_ok');
    expect(result.wall_time).toBe(wallTime);
  });
});
