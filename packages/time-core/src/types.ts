// Contract per docs/design/05-time-core.md §1 (first|second|none).
// Zero imports: no external deps allowed in packages/time-core/src (D1 gate).
export type FoldChoice = 'first' | 'second' | 'none';

export interface ZoneTransition {
  readonly at_utc: string;
  readonly offset_seconds: number;
}

export interface ZoneRules {
  readonly base_offset_seconds: number;
  readonly transitions: readonly ZoneTransition[];
  readonly coverage: {
    readonly wall_start: string;
    readonly wall_end: string;
    readonly utc_start: string;
    readonly utc_end: string;
  };
}

export interface AliasTable {
  readonly version: string;
  readonly aliases: Readonly<Record<string, string>>;
}

export interface TimeRuleset {
  readonly ruleset_id: string;
  readonly tzdb_version: string;
  readonly zones: Readonly<Record<string, ZoneRules>>;
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
