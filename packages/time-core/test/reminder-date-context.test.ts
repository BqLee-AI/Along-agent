import { describe, expect, it } from 'bun:test';
import { ALIAS_TABLE_V1, classifyEntry } from '../src/entry.js';
import { FIXTURE_V1 } from '../src/fixtures/fixture-v1.js';
import { normalize } from '../src/normalize.js';

function reminder(
  anchor: string,
  received: string,
  text = '今天15:20提醒我喝水',
  confirmedTz = 'Asia/Shanghai',
) {
  return classifyEntry({
    text,
    anchorReceivedAtUtc: anchor,
    receivedAtUtc: received,
    confirmedTz,
    ruleset: FIXTURE_V1,
    aliases: ALIAS_TABLE_V1,
    requireCompleteReminder: true,
  });
}

describe('reminder date clarification boundaries', () => {
  it('preserves the original date after 120 seconds on the same confirmed local day', () => {
    expect(reminder('2026-11-01T02:00:00Z', '2026-11-01T02:02:00Z')).toMatchObject({
      class: 'normalize_ok',
      wall_time: '2026-11-01T15:20:00',
      timezone_id: 'Asia/Shanghai',
    });
  });

  it('does not silently reinterpret the original today after 20 seconds across local midnight', () => {
    expect(reminder('2026-11-01T15:59:50Z', '2026-11-01T16:00:10Z')).toMatchObject({
      class: 'clarify',
      reason: 'DATE_CHANGED',
      phrase_key: 'ASK_DATE_RECONFIRM',
    });
  });

  it('does not treat UTC midnight as a date change on the same confirmed local day', () => {
    expect(reminder('2026-11-01T23:59:50Z', '2026-11-02T00:00:10Z')).toMatchObject({
      class: 'normalize_ok',
      wall_time: '2026-11-02T15:20:00',
      timezone_id: 'Asia/Shanghai',
    });
  });

  it('asks for a timezone before deciding whether the local date changed', () => {
    expect(reminder('2026-11-01T15:59:50Z', '2026-11-01T16:00:10Z', undefined, '')).toMatchObject({
      class: 'clarify',
      reason: 'TIMEZONE_MISSING',
    });
  });

  it('asks for a missing date without pretending local midnight was crossed', () => {
    expect(
      reminder('2026-11-01T02:00:00Z', '2026-11-01T02:02:00Z', '15:20提醒我喝水'),
    ).toMatchObject({
      class: 'clarify',
      reason: 'DATE_MISSING',
      phrase_key: 'ASK_DATE',
    });
  });

  it.each([
    ['今天三点提醒我喝水', 'DAYPART_MISSING'],
    ['今天15:20提醒我', 'CONTENT_MISSING'],
  ])('still clarifies incomplete reminders after a same-day delay: %s', (text, reason) => {
    expect(reminder('2026-11-01T02:00:00Z', '2026-11-01T02:02:00Z', text)).toMatchObject({
      class: 'clarify',
      reason,
    });
  });

  it('keeps an elapsed target in the past for the independent consumer future-time gate', () => {
    const result = reminder('2026-11-01T02:00:00Z', '2026-11-01T02:02:00Z', '今天10:01提醒我喝水');
    expect(result).toMatchObject({
      class: 'normalize_ok',
      wall_time: '2026-11-01T10:01:00',
      timezone_id: 'Asia/Shanghai',
    });
    const normalized = normalize(
      result.wall_time!,
      result.timezone_id!,
      result.fold ?? 'none',
      FIXTURE_V1,
    );
    expect(normalized).toMatchObject({
      kind: 'ok',
      fire_at_utc: '2026-11-01T02:01:00Z',
    });
  });
});
