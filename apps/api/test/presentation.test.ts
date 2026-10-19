import { describe, expect, it } from 'vitest';
import {
  computePresentationHash,
  encodePresentationCanonical,
  normalizeLayoutWhitespace,
  renderEchoV1,
  renderEchoV1Second,
  shortNoOf,
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
  it('hash is stable for the same snapshot', () => {
    expect(computePresentationHash(SNAPSHOT)).toBe(computePresentationHash(SNAPSHOT));
    expect(computePresentationHash(SNAPSHOT).startsWith('ph_')).toBe(true);
  });

  it('hash pins the frozen v1 digest', () => {
    expect(computePresentationHash(SNAPSHOT)).toBe(
      'ph_9baa511f0a012bfe50e0fea99b475efc088d65f32d907780765fbbfe2c189739',
    );
  });

  it('canonical encoding is length-prefixed with domain', () => {
    const canonical = encodePresentationCanonical(SNAPSHOT);
    expect(canonical.startsWith('21:along-presentation/v1')).toBe(true);
  });

  it('short number is display-only', () => {
    expect(shortNoOf('11111111-1111-1111-1111-111111111111')).toBe('A-1111');
  });

  it('echo v1 renders the ordinary template', () => {
    const echo = renderEchoV1(SNAPSHOT, 'A-1111');
    expect(echo).toContain('请确认 A-1111');
    expect(echo).toContain('明天 9:20 喝水');
    expect(echo).toContain('2026-10-17 09:20');
  });

  it('echo v1 second renders the ambiguous variant', () => {
    const second = { ...SNAPSHOT, fold: 1 as const, offsetSeconds: -18000 };
    const echo = renderEchoV1Second(second);
    expect(echo).toContain('第二次出现');
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

  it('layout whitespace collapse is full-width aware', () => {
    expect(normalizeLayoutWhitespace('请确认　A-1111 ：')).toBe('请确认 A-1111 ：');
  });
});
