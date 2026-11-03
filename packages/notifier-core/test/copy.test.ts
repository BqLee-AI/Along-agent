import { describe, expect, it } from 'bun:test';
import {
  CANCEL_CONFIRMING_COPY,
  CANCEL_INTERCEPT_COPY,
  INAPP_CAPABILITIES,
  INAPP_CHANNEL,
  MISSED_COPY,
  RECEIPT_COPY,
  notificationStatusOf,
  noticeCopyFor,
  outcomeOf,
} from '../src/index.js';

describe('notifier-core copy ceiling', () => {
  it('stays in-app and reports degraded capabilities', () => {
    expect(INAPP_CHANNEL).toBe('inapp');
    expect(INAPP_CAPABILITIES).toEqual({
      supportsIdempotencyKey: false,
      supportsLookupByKey: false,
      supportsCancelIntercept: false,
    });
  });

  it('builds copy from frozen fields with the recorded wording', () => {
    const copy = noticeCopyFor({
      wallTime: '2026-10-17 09:20',
      timezoneId: 'Asia/Shanghai',
      originalNote: '喝水',
    });
    expect(copy.title).toBe('提醒 2026-10-17 09:20 Asia/Shanghai');
    expect(copy.body).toContain(RECEIPT_COPY);
    expect(copy.body).toContain('2026-10-17 09:20');
    expect(copy.body).not.toMatch(/必达|已读|一定响|保证送达/);
  });

  it('renders frozen elapsed seconds, UTC, offset and basis without changing legacy copy', () => {
    const copy = noticeCopyFor({
      wallTime: '2026-10-17 09:20:37',
      timezoneId: 'Asia/Shanghai',
      originalNote: '喝水',
      elapsedDisplay: {
        fireAtUtc: '2026-10-17T01:20:37.000Z',
        offsetSeconds: 28800,
        anchorUtc: '2026-10-17T01:19:07.000Z',
        durationSeconds: 90,
      },
    });
    expect(copy.title).toBe('提醒 2026-10-17 09:20:37 Asia/Shanghai UTC+08:00');
    expect(copy.body).toContain('UTC 2026-10-17T01:20:37.000Z');
    expect(copy.body).toContain('2026-10-17T01:19:07.000Z 起经过 90 秒');
    expect(copy.body).not.toMatch(/必达|已读|一定响|保证送达/);
  });

  it('renders zero and second-precision negative frozen offsets', () => {
    const fields = {
      wallTime: '2026-10-17 01:20:37',
      timezoneId: 'UTC',
      originalNote: null,
      elapsedDisplay: {
        fireAtUtc: '2026-10-17T01:20:37.000Z',
        offsetSeconds: 0,
        anchorUtc: '2026-10-17T01:20:36.000Z',
        durationSeconds: 1,
      },
    };
    expect(noticeCopyFor(fields).title).toContain('UTC+00:00');
    expect(
      noticeCopyFor({
        ...fields,
        elapsedDisplay: { ...fields.elapsedDisplay, offsetSeconds: -18030 },
      }).title,
    ).toContain('UTC-05:00:30');
  });

  it('keeps the cancel-intercept and missed wording frozen', () => {
    expect(CANCEL_INTERCEPT_COPY).toContain('仍无法确认');
    expect(MISSED_COPY).toContain('已错过');
    expect(CANCEL_CONFIRMING_COPY).toContain('尚未取消');
    for (const text of [CANCEL_INTERCEPT_COPY, MISSED_COPY, RECEIPT_COPY]) {
      expect(text).not.toMatch(/必达|已读|一定响|保证送达/);
    }
  });

  it('maps provider results to persisted outcomes', () => {
    expect(outcomeOf({ delivered: true, answered: true })).toBe('sent');
    expect(outcomeOf({ delivered: false, answered: false })).toBe('ack_unknown');
    expect(outcomeOf({ delivered: false, answered: true })).toBe('failed');
    expect(notificationStatusOf('sent')).toBe('sent');
    expect(notificationStatusOf('ack_unknown')).toBe('pending');
    expect(notificationStatusOf('failed')).toBe('failed');
  });
});
