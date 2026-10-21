import { describe, expect, it } from 'bun:test';
import {
  computePresentationHash,
  renderEchoV1,
  renderEchoV1Second,
  validateSeenContent,
  type PresentationSnapshot,
} from '../src/modules/approvals/presentation.js';

const SNAPSHOT: PresentationSnapshot = {
  originalText: '明天 9:20 喝水',
  localDatetime: '2026-10-17 09:20',
  timezoneId: 'Asia/Shanghai',
  fold: 0,
  offsetSeconds: 28800,
  occurrence: 'single',
  presentationVersion: 'v1',
};

describe('presentation contract', () => {
  it('hash pins the frozen v1 digest', () => {
    expect(computePresentationHash(SNAPSHOT)).toBe(
      'ph_9baa511f0a012bfe50e0fea99b475efc088d65f32d907780765fbbfe2c189739',
    );
  });

  it('v1 second keeps the chosen occurrence and frozen offset', () => {
    const second: PresentationSnapshot = {
      ...SNAPSHOT,
      originalText: '2026-11-01 01:30 提醒我喝水',
      localDatetime: '2026-11-01 01:30',
      timezoneId: 'America/New_York',
      fold: 1,
      offsetSeconds: -18000,
    };
    const echo = renderEchoV1Second(second);
    expect(echo).toContain('第二次出现');
    expect(echo).toContain('UTC-05:00');
  });

  it('first-v2 binds the visible occurrence and frozen offset rather than accepting the old ordinary echo', () => {
    const first: PresentationSnapshot = {
      ...SNAPSHOT,
      originalText: '2026-11-01 01:30 提醒我喝水',
      localDatetime: '2026-11-01 01:30',
      timezoneId: 'America/New_York',
      offsetSeconds: -14400,
      presentationVersion: 'v2',
    };
    const seen =
      "原话'2026-11-01 01:30 提醒我喝水'，按 America/New_York " +
      '选择第一次出现的 2026-11-01 01:30（UTC-04:00），' +
      '单次提醒；确认前不会创建正式提醒或排期。';
    for (const [seenContent, valid] of [
      [seen, true],
      [seen.replace('第一次', '第二次'), false],
      [seen.replace('UTC-04:00', 'UTC-05:00'), false],
      [renderEchoV1(first, 'A-1111'), false],
    ] as const) {
      expect(
        validateSeenContent({
          seenContent,
          snapshot: first,
          shortNo: 'A-1111',
          variant: 'ordinary',
          presentationVersion: 'v2',
        }),
      ).toBe(valid);
    }
  });

  it('seen_content accepts layout whitespace but not original edits', () => {
    const echo = renderEchoV1(SNAPSHOT, 'A-1111');
    // Layout-tolerant: pad with full-width spaces around template text only.
    const padded = `　${echo}　`;
    expect(
      validateSeenContent({
        seenContent: padded,
        snapshot: SNAPSHOT,
        shortNo: 'A-1111',
        variant: 'ordinary',
        presentationVersion: 'v1',
      }),
    ).toBe(true);
    expect(
      validateSeenContent({
        seenContent: echo.replace('明天 9:20 喝水', '明天 9:30 喝水'),
        snapshot: SNAPSHOT,
        shortNo: 'A-1111',
        variant: 'ordinary',
        presentationVersion: 'v1',
      }),
    ).toBe(false);
  });

  it('unknown presentation version fails closed', () => {
    expect(
      validateSeenContent({
        seenContent: 'anything',
        snapshot: SNAPSHOT,
        shortNo: 'A-1111',
        variant: 'ordinary',
        presentationVersion: 'v9',
      }),
    ).toBe(false);
  });
});
