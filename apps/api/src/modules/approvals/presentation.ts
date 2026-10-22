import { createHash } from 'node:crypto';

// Presentation contract: design/06 §5.
// computePresentationHash is the single canonical encoder for the hash that
// confirm (PR2) will compare against the frozen approvals.presentation_hash.
// Algorithm (also documented in design/06 §5):
//   canonical = len-prefixed fields joined by 0x1F separators, prefixed with
//   domain "along-presentation/v1":
//     presentation_version | original_text (verbatim, spaces count) |
//     normalized local datetime "YYYY-MM-DD HH:mm" | timezone_id |
//     fold ("0"|"1") | offset_seconds | occurrence
//   hash = "ph_" + sha256(canonical, hex)
// Layout whitespace in the *template* never enters the hash; original_text
// whitespace is byte-exact.

export const PRESENTATION_VERSION_V1 = 'v1';
// The first-occurrence template has its own frozen version; v1 approvals
// must keep their original ordinary/second/cancel presentation.
export const PRESENTATION_VERSION_FIRST_V2 = 'v2';

export interface PresentationSnapshot {
  originalText: string;
  localDatetime: string; // "YYYY-MM-DD HH:mm" already normalized by time-core
  timezoneId: string;
  fold: 0 | 1;
  offsetSeconds: number;
  occurrence: 'single';
  presentationVersion: string;
}

function lenPrefix(s: string): string {
  return `${Buffer.byteLength(s, 'utf8')}:${s}`;
}

export function encodePresentationCanonical(snapshot: PresentationSnapshot): string {
  const fields = [
    'along-presentation/v1',
    snapshot.presentationVersion,
    snapshot.originalText,
    snapshot.localDatetime,
    snapshot.timezoneId,
    String(snapshot.fold),
    String(snapshot.offsetSeconds),
    snapshot.occurrence,
  ];
  return fields.map(lenPrefix).join('');
}

export function computePresentationHash(snapshot: PresentationSnapshot): string {
  const digest = createHash('sha256')
    .update(encodePresentationCanonical(snapshot), 'utf8')
    .digest('hex');
  return `ph_${digest}`;
}

// Short display number: "A-" + first 4 hex chars of the approval UUID.
// Display-only: never used for auth or lookup.
export function shortNoOf(approvalId: string): string {
  const hex = approvalId.replace(/-/g, '').slice(0, 4).toUpperCase();
  return `A-${hex}`;
}

// v1 echo template (ordinary variant), design/06 §2:
// "请确认 A-XXXX：你说'<original>'，我将它归一为 <local>（<tz>），设为单次提醒；确认前不会创建正式提醒，也不会排期。"
export function renderEchoV1(snapshot: PresentationSnapshot, shortNo: string): string {
  return (
    `请确认 ${shortNo}：你说'${snapshot.originalText}'，` +
    `我将它归一为 ${snapshot.localDatetime}（${snapshot.timezoneId}），` +
    `设为单次提醒；确认前不会创建正式提醒，也不会排期。`
  );
}

// Ambiguous second-occurrence variant, design/06 §2:
// "原话'<original>'，按 <tz> 选择第二次出现的 <local>（UTC±HH:MM），单次提醒；确认前不会创建正式提醒或排期。"
export function renderEchoV1Second(snapshot: PresentationSnapshot): string {
  return (
    `原话'${snapshot.originalText}'，按 ${snapshot.timezoneId} ` +
    `选择第二次出现的 ${snapshot.localDatetime}（${formatUtcOffset(snapshot.offsetSeconds)}），` +
    `单次提醒；确认前不会创建正式提醒或排期。`
  );
}

export function renderCreateTaskEcho(snapshot: PresentationSnapshot, shortNo: string): string {
  if (snapshot.presentationVersion === PRESENTATION_VERSION_FIRST_V2) {
    return (
      `原话'${snapshot.originalText}'，按 ${snapshot.timezoneId} ` +
      `选择第一次出现的 ${snapshot.localDatetime}（${formatUtcOffset(snapshot.offsetSeconds)}），` +
      `单次提醒；确认前不会创建正式提醒或排期。`
    );
  }
  return snapshot.fold === 1 ? renderEchoV1Second(snapshot) : renderEchoV1(snapshot, shortNo);
}

// Cancel variant (issue #9, request_cancel_task). Same frozen snapshot fields
// feed the hash; only the template sentence differs.
export function renderEchoCancelV1(snapshot: PresentationSnapshot, shortNo: string): string {
  return (
    `请确认 ${shortNo}：你说'${snapshot.originalText}'，` +
    `我将取消这条提醒（${snapshot.localDatetime}，${snapshot.timezoneId}）；` +
    `确认前不会改动任务。`
  );
}

export function formatUtcOffset(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? '-' : '+';
  const abs = Math.abs(offsetSeconds);
  const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
  const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

// Collapse all runs of whitespace (including full-width U+3000) to a single
// ASCII space and trim. Used ONLY for template-literal segments; the
// original_text segment is always compared byte-exact.
export function normalizeLayoutWhitespace(s: string): string {
  return s.replace(/[\s　]+/g, ' ').trim();
}

export interface ValidateSeenInput {
  seenContent: string;
  snapshot: PresentationSnapshot;
  shortNo: string;
  variant: 'ordinary' | 'second' | 'cancel';
  presentationVersion: string;
}

// Returns true when seen_content matches the expected echo: template
// segments compared layout-tolerant (normalizeLayoutWhitespace), the
// original_text segment compared byte-exact. Unknown versions fail closed.
export function validateSeenContent(input: ValidateSeenInput): boolean {
  if (input.presentationVersion !== input.snapshot.presentationVersion) return false;
  const first = input.presentationVersion === PRESENTATION_VERSION_FIRST_V2;
  if (
    first
      ? input.snapshot.fold !== 0 || input.variant !== 'ordinary'
      : input.presentationVersion !== PRESENTATION_VERSION_V1
  )
    return false;
  const expected = first
    ? renderCreateTaskEcho(input.snapshot, input.shortNo)
    : input.variant === 'ordinary'
      ? renderEchoV1(input.snapshot, input.shortNo)
      : input.variant === 'second'
        ? renderEchoV1Second(input.snapshot)
        : renderEchoCancelV1(input.snapshot, input.shortNo);
  const original = input.snapshot.originalText;
  // Split both strings on the single original_text occurrence. Template
  // segments around it are compared layout-tolerant; original byte-exact.
  const splitAt = (s: string): [string, string] | null => {
    const i = s.indexOf(original);
    if (i < 0) return null;
    return [s.slice(0, i), s.slice(i + original.length)];
  };
  const e = splitAt(expected);
  const g = splitAt(input.seenContent);
  if (!e || !g) {
    // original_text empty or absent: fall back to full-string layout compare
    // only when there is no original text to protect.
    if (original === '') {
      return normalizeLayoutWhitespace(input.seenContent) === normalizeLayoutWhitespace(expected);
    }
    return false;
  }
  return (
    normalizeLayoutWhitespace(g[0]) === normalizeLayoutWhitespace(e[0]) &&
    normalizeLayoutWhitespace(g[1]) === normalizeLayoutWhitespace(e[1])
  );
}
