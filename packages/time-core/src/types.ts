// Contract per docs/design/05-time-core.md §1 (first|second|none).
// Zero imports: no external deps allowed in packages/time-core/src (D1 gate).
export type FoldChoice = 'first' | 'second' | 'none';

export interface ZoneTransition {
  at_utc: string;
  offset_seconds: number;
}

export interface ZoneRules {
  base_offset_seconds: number;
  transitions: ZoneTransition[];
}

export interface TimeRuleset {
  ruleset_id: string;
  tzdb_version: string;
  zones: Record<string, ZoneRules>;
}

export interface AmbiguousCandidate {
  fold_choice: 'first' | 'second';
  offset_seconds: number;
  fire_at_utc: string;
}

export interface NormalizeOk {
  kind: 'ok';
  fire_at_utc: string;
  offset_seconds: number;
  fold: 0 | 1;
  ruleset_id: string;
}

export type NormalizeErrorCode =
  | 'NONEXISTENT_LOCAL_TIME'
  | 'AMBIGUOUS_LOCAL_TIME'
  | 'UNKNOWN_TIMEZONE'
  | 'TZDB_UNAVAILABLE';

export interface NormalizeError {
  kind: 'error';
  error: NormalizeErrorCode;
  candidates?: AmbiguousCandidate[];
  ruleset_id?: string;
}

export type NormalizeResult = NormalizeOk | NormalizeError;
