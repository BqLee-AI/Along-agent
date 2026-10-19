import { describe, expect, it } from 'vitest';
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
