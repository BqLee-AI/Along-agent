// Package entry: #3 normalize API. Type shell intentionally replaced:
// FoldChoice earlier|later|ask -> first|second|none per design/05 §1 (contract fix, no callers).
export type {
  AliasTable,
  AmbiguousCandidate,
  FoldChoice,
  NormalizeError,
  NormalizeErrorCode,
  NormalizeOk,
  NormalizeResult,
  TimeRuleset,
  ZoneRules,
  ZoneTransition,
} from './types.js';
export { FIXTURE_V1 } from './fixtures/fixture-v1.js';
export { normalize, formatUtc } from './normalize.js';
export { classifyEntry, findReminderDirective, ALIAS_TABLE_V1 } from './entry.js';
export type { EntryClass, EntryClassifyResult } from './entry.js';
export type { EntryInput } from './entry.js';
export { isSupportedRuleset, utcInCoverage } from './profile.js';
export { freezeValue, sameValue } from './immutable.js';
export { reminderDateExpression, reminderTimezoneReply } from './reminder-source.js';
