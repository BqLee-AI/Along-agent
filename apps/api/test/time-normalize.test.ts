import { describe, expect, it } from 'bun:test';
import { ALIAS_TABLE_V1, FIXTURE_V1 } from '@along/time-core';
import { createTimeContext, loadTimeContext } from '../src/features/time/context.js';
import { normalizeTime, type NormalizeTimeInput } from '../src/features/time/normalize.js';

const context = loadTimeContext('fixture-v1');
const input: NormalizeTimeInput = {
  raw_text: '2026-11-01 01:30 提醒我喝水',
  confirmedTimezone: 'America/New_York',
  anchorReceivedAtUtc: '2026-10-21T12:00:00Z',
  receivedAtUtc: '2026-10-21T12:00:00Z',
  foldChoice: 'none',
};

describe('reminder text and calendar boundaries', () => {
  it('keeps ordinary meeting-time wording out of timezone metadata', () => {
    for (const raw_text of [
      '2026-11-01 09:20 提醒我确认会议时间',
      '2026-11-01 09:20 北京时间提醒我确认会议时间',
      '2026-11-01 09:20 叫我确认会议时间',
      '2026-11-01 09:20 通知我确认会议时间',
      '2026-11-01 09:20 记得确认会议时间',
      '2026-11-01 09:20 别忘了确认会议时间',
    ]) {
      expect(
        normalizeTime(context, { ...input, raw_text, confirmedTimezone: 'Asia/Shanghai' }),
      ).toMatchObject({
        kind: 'ok',
        wall_time: '2026-11-01T09:20:00',
        timezone_id: 'Asia/Shanghai',
        normalized: { fire_at_utc: '2026-11-01T01:20:00Z' },
      });
    }
    expect(
      normalizeTime(context, {
        ...input,
        raw_text: '2026-11-01 09:20 提醒我喝水（火星时间）',
        confirmedTimezone: 'Asia/Shanghai',
      }),
    ).toMatchObject({ kind: 'error', error: { code: 'UNKNOWN_TIMEZONE', http_status: 422 } });
  });

  it('rejects a nonexistent ISO date before converting 24:00 to the next day', () => {
    expect(
      normalizeTime(context, {
        ...input,
        raw_text: '2027-02-29 24:00 提醒我喝水',
        confirmedTimezone: 'Asia/Shanghai',
      }),
    ).toMatchObject({ kind: 'error', error: { code: 'NONEXISTENT_LOCAL_TIME', http_status: 422 } });
    expect(
      normalizeTime(context, {
        ...input,
        raw_text: '2027-02-28 24:00 提醒我喝水',
        confirmedTimezone: 'Asia/Shanghai',
      }),
    ).toMatchObject({
      kind: 'ok',
      wall_time: '2027-03-01T00:00:00',
      normalized: { fire_at_utc: '2027-02-28T16:00:00Z' },
    });
  });

  it('checks complete reminder fields while keeping separate content out of the time text', () => {
    const complete = {
      ...input,
      raw_text: '2027年11月2日下午三点二十分',
      confirmedTimezone: 'Asia/Shanghai',
      requireCompleteReminder: true,
      reminderContent: '买二十三瓶水',
    };
    expect(normalizeTime(context, complete)).toMatchObject({
      kind: 'ok',
      wall_time: '2027-11-02T15:20:00',
      normalized: { fire_at_utc: '2027-11-02T07:20:00Z' },
    });
    expect(normalizeTime(context, { ...complete, reminderContent: '✅' })).toMatchObject({
      kind: 'ok',
      normalized: { fire_at_utc: '2027-11-02T07:20:00Z' },
    });
    for (const [override, reason] of [
      [{ raw_text: '下午三点二十分' }, 'DATE_MISSING'],
      [{ reminderContent: '   ' }, 'CONTENT_MISSING'],
      [{ confirmedTimezone: null }, 'TIMEZONE_MISSING'],
      [{ raw_text: '2027年11月2日三点二十分' }, 'DAYPART_MISSING'],
    ] as const) {
      expect(normalizeTime(context, { ...complete, ...override })).toMatchObject({
        kind: 'clarify',
        classified: { reason },
      });
    }
  });
});

describe('application normalization context', () => {
  it('loads the real immutable rules and aliases', () => {
    expect(context.available).toBe(true);
    if (!context.available) throw new Error('production time resources unavailable');
    expect(Object.isFrozen(context.ruleset.zones['America/New_York'].transitions)).toBe(true);
    expect(Object.isFrozen(context.aliases.aliases)).toBe(true);
    expect(normalizeTime(context, input)).toMatchObject({
      kind: 'error',
      error: {
        code: 'AMBIGUOUS_LOCAL_TIME',
        http_status: 422,
        details: {
          wall_time: '2026-11-01T01:30:00',
          timezone_id: 'America/New_York',
          ruleset_id: 'FIXTURE_V1',
          candidates: [
            { fold_choice: 'first', offset_seconds: -14400, fire_at_utc: '2026-11-01T05:30:00Z' },
            { fold_choice: 'second', offset_seconds: -18000, fire_at_utc: '2026-11-01T06:30:00Z' },
          ],
        },
      },
    });
  });

  it('requires the actual complete profile and alias contents, not labels', () => {
    const variants = [
      createTimeContext(undefined, FIXTURE_V1, ALIAS_TABLE_V1),
      createTimeContext('2024a', FIXTURE_V1, ALIAS_TABLE_V1),
      createTimeContext('fixture-v1', null, ALIAS_TABLE_V1),
      createTimeContext('fixture-v1', FIXTURE_V1, null),
      createTimeContext('fixture-v1', { ...FIXTURE_V1, ruleset_id: 'OTHER' }, ALIAS_TABLE_V1),
      createTimeContext('fixture-v1', FIXTURE_V1, { ...ALIAS_TABLE_V1, aliases: {} }),
      createTimeContext('fixture-v1', FIXTURE_V1, { ...ALIAS_TABLE_V1, version: 'OTHER' }),
      createTimeContext('fixture-v1', FIXTURE_V1, {
        ...ALIAS_TABLE_V1,
        aliases: { ...ALIAS_TABLE_V1.aliases, 纽约时间: 'Mars/Olympus' },
      }),
      createTimeContext(
        'fixture-v1',
        { ...FIXTURE_V1, zones: { 'Asia/Shanghai': FIXTURE_V1.zones['Asia/Shanghai'] } },
        ALIAS_TABLE_V1,
      ),
    ];
    for (const bad of variants) {
      expect(bad.available).toBe(false);
      expect(normalizeTime(bad, input)).toMatchObject({
        kind: 'error',
        error: { code: 'TZDB_UNAVAILABLE', http_status: 503 },
      });
    }
  });

  it('does not mutate or borrow caller-owned admitted input', () => {
    const aliases = { version: 'ALIAS_TABLE_V1', aliases: { ...ALIAS_TABLE_V1.aliases } };
    const admitted = createTimeContext('fixture-v1', FIXTURE_V1, aliases);
    aliases.aliases.纽约时间 = 'Mars/Olympus';
    expect(
      normalizeTime(admitted, { ...input, raw_text: '纽约时间 2026-11-01 01:30' }),
    ).toMatchObject({ error: { code: 'AMBIGUOUS_LOCAL_TIME' } });
  });

  it('unknown explicit IDs and aliases never fall back to a confirmed timezone', () => {
    for (const confirmedTimezone of [null, 'Asia/Shanghai']) {
      for (const text of ['火星时间', 'Mars/Olympus', '北京时间 火星时间', 'Asia/Tokyo']) {
        expect(
          normalizeTime(context, {
            ...input,
            confirmedTimezone,
            raw_text: `${text} 2026-11-01 01:30`,
          }),
        ).toMatchObject({ kind: 'error', error: { code: 'UNKNOWN_TIMEZONE', http_status: 422 } });
      }
    }
    expect(normalizeTime(context, { ...input, confirmedTimezone: 'Mars/Olympus' })).toMatchObject({
      error: { code: 'UNKNOWN_TIMEZONE' },
    });
    expect(context.available).toBe(true);
  });

  it('one explicit timezone wins; differing explicit zones ask, not table-order pick', () => {
    expect(
      normalizeTime(context, {
        ...input,
        confirmedTimezone: 'Asia/Shanghai',
        raw_text: '纽约时间 2026-11-01 01:30',
      }),
    ).toMatchObject({ error: { code: 'AMBIGUOUS_LOCAL_TIME' } });
    expect(
      normalizeTime(context, { ...input, raw_text: '北京时间 纽约时间 2026-11-01 01:30' }),
    ).toMatchObject({ kind: 'clarify', classified: { reason: 'TIMEZONE_CONFLICT' } });
    expect(
      normalizeTime(context, { ...input, raw_text: '纽约时间 America/New_York 2026-11-01 01:30' }),
    ).toMatchObject({ error: { code: 'AMBIGUOUS_LOCAL_TIME' } });
  });

  it('fold selection is structured, preserves seconds, and is not confirmation', () => {
    for (const [foldChoice, utc, offset, fold] of [
      ['first', '2026-11-01T05:30:00Z', -14400, 0],
      ['second', '2026-11-01T06:30:00Z', -18000, 1],
    ] as const) {
      expect(normalizeTime(context, { ...input, foldChoice })).toMatchObject({
        kind: 'ok',
        normalized: { fire_at_utc: utc, offset_seconds: offset, fold },
      });
    }
    expect(
      normalizeTime(context, { ...input, raw_text: `${input.raw_text} 第二次` }),
    ).toMatchObject({ error: { code: 'AMBIGUOUS_LOCAL_TIME' } });
    expect(
      normalizeTime(context, {
        ...input,
        raw_text: `${input.raw_text} 第二次`,
        foldChoice: 'first',
      }),
    ).toMatchObject({ kind: 'clarify', classified: { reason: 'FOLD_CONFLICT' } });
  });

  it('ordinary missing information remains clarification', () => {
    for (const raw_text of ['提醒我喝水', '11月1日 01:30', '2026-11-01 1点', '明天 9点左右']) {
      expect(normalizeTime(context, { ...input, raw_text })).toMatchObject({ kind: 'clarify' });
    }
    expect(normalizeTime(context, { ...input, confirmedTimezone: null })).toMatchObject({
      kind: 'clarify',
    });
  });

  it('absolute inputs ignore unrelated out-of-range clocks; relative inputs do not', () => {
    const clocks = {
      anchorReceivedAtUtc: '2030-01-01T00:00:00Z',
      receivedAtUtc: '2030-01-01T00:00:00Z',
    };
    expect(normalizeTime(context, { ...input, ...clocks, foldChoice: 'first' })).toMatchObject({
      kind: 'ok',
    });
    expect(normalizeTime(context, { ...input, ...clocks, raw_text: '明天 9:20' })).toMatchObject({
      error: { code: 'TZDB_UNAVAILABLE', http_status: 503 },
    });
  });

  it('24:00 and relative next day cannot cross the upper bound, in any supported zone', () => {
    for (const [confirmedTimezone, anchor] of [
      ['Asia/Shanghai', '2027-12-30T16:00:00Z'],
      ['Pacific/Kiritimati', '2027-12-30T10:00:00Z'],
      ['America/New_York', '2027-12-31T05:00:00Z'],
    ]) {
      for (const raw_text of ['明天 9:20', '2027-12-31 24:00', '2027年12月31日24:00']) {
        expect(
          normalizeTime(context, {
            ...input,
            confirmedTimezone,
            raw_text,
            anchorReceivedAtUtc: anchor,
            receivedAtUtc: anchor,
          }),
        ).toMatchObject({ error: { code: 'TZDB_UNAVAILABLE', http_status: 503 } });
      }
    }
  });

  it('persistent anchors are not replaced on delayed/cross-midnight re-proposals', () => {
    const anchored = {
      ...input,
      raw_text: '明天 01:30',
      anchorReceivedAtUtc: '2026-10-31T12:00:00Z',
    };
    for (const receivedAtUtc of ['2026-10-31T12:00:30Z', '2026-10-31T12:02:00Z']) {
      expect(
        normalizeTime(context, { ...anchored, receivedAtUtc, foldChoice: 'second' }),
      ).toMatchObject({ kind: 'ok', normalized: { fire_at_utc: '2026-11-01T06:30:00Z' } });
    }
    expect(
      normalizeTime(context, {
        ...anchored,
        receivedAtUtc: '2026-11-01T05:00:00Z',
        foldChoice: 'second',
      }),
    ).toMatchObject({ kind: 'clarify', classified: { reason: 'DATE_CHANGED' } });
  });
});
