// Package entry: #3 normalize API. Type shell intentionally replaced:
// FoldChoice earlier|later|ask -> first|second|none per design/05 §1 (contract fix, no callers).
export type {
  AmbiguousCandidate,
  FoldChoice,
  NormalizeError,
  NormalizeErrorCode,
  NormalizeOk,
  NormalizeResult,
  TimeRuleset,
  ZoneRules,
  ZoneTransition,
} from "./types.js";
export { FIXTURE_V1 } from "./fixtures/fixture-v1.js";
export { normalize, formatUtc } from "./normalize.js";
export { classifyEntry, ALIAS_TABLE_V1 } from "./entry.js";
export type { EntryClass, EntryClassifyResult } from "./entry.js";
