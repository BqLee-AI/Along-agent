import { FIXTURE_V1 } from './fixtures/fixture-v1.js';
import { sameValue } from './immutable.js';
import { parseUtcEpoch } from './civil.js';
import type { TimeRuleset } from './types.js';

// A version identifies content, not merely a label. Never repair a damaged pack.
export function isSupportedRuleset(value: unknown): value is TimeRuleset {
  return sameValue(value, FIXTURE_V1);
}

export function utcInCoverage(ruleset: TimeRuleset, timezoneId: string, utc: string): boolean {
  const coverage = ruleset.zones[timezoneId]?.coverage;
  const epoch = parseUtcEpoch(utc);
  if (!coverage || epoch === null) return false;
  const start = parseUtcEpoch(coverage.utc_start);
  const end = parseUtcEpoch(coverage.utc_end);
  return start !== null && end !== null && epoch >= start && epoch < end;
}
