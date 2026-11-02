import { describe, expect, it } from 'bun:test';
import { ALIAS_TABLE_V1, classifyEntry } from '../src/entry.js';
import { FIXTURE_V1 } from '../src/fixtures/fixture-v1.js';

function reminder(anchor: string, received: string, text = '今天15:20提醒我喝水') {
  return classifyEntry({
    text,
    anchorReceivedAtUtc: anchor,
    receivedAtUtc: received,
    confirmedTz: 'Asia/Shanghai',
    ruleset: FIXTURE_V1,
    aliases: ALIAS_TABLE_V1,
    requireCompleteReminder: true,
  });
}

describe('reminder date clarification reasons', () => {
  it('does not silently reinterpret the original today after local midnight', () => {
    expect(reminder('2026-11-01T15:59:50Z', '2026-11-01T16:00:05Z')).toMatchObject({
      class: 'clarify',
      reason: 'DATE_CHANGED',
      phrase_key: 'ASK_DATE_RECONFIRM',
    });
  });
  it('asks for a missing date without pretending local midnight was crossed', () => {
    expect(
      reminder('2026-11-01T07:08:21Z', '2026-11-01T07:08:21Z', '15:20提醒我喝水'),
    ).toMatchObject({
      class: 'clarify',
      reason: 'DATE_MISSING',
      phrase_key: 'ASK_DATE',
    });
  });
});
