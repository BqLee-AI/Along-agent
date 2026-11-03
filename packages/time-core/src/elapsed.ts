// Strict elapsed arithmetic and instant-to-wall conversion, independent of clocks and host timezone.
import { civilFromEpoch, formatUtc, parseUtcEpoch, wallPartsToString } from './civil.js';
import { normalize } from './normalize.js';
import { isSupportedRuleset, utcInCoverage } from './profile.js';
import type { TimeRuleset } from './types.js';

const MAX_EPOCH = 253402300799; // 9999-12-31T23:59:59Z
const MIN_EPOCH = -62167219200; // 0000-01-01T00:00:00Z

/** Add whole nonnegative seconds to a canonical second-precision UTC anchor. */
export function addElapsed(anchorUtc: string, seconds: number): string | null {
  if (typeof anchorUtc !== 'string' || !Number.isSafeInteger(seconds) || seconds < 0) return null;
  const anchor = parseUtcEpoch(anchorUtc);
  if (anchor === null || seconds > MAX_EPOCH - anchor) return null;
  return formatUtc(anchor + seconds);
}

export type UtcToLocalResult =
  | { kind: 'ok'; wall_time: string; offset_seconds: number; fold: 0 | 1; ruleset_id: string }
  | { kind: 'error'; error: 'INVALID_UTC' | 'UNKNOWN_TIMEZONE' | 'TZDB_UNAVAILABLE' };

/** Convert an instant only using the supplied supported rules and their coverage. */
export function utcToLocal(
  utc: string,
  timezoneId: string,
  ruleset: TimeRuleset,
): UtcToLocalResult {
  const epoch = typeof utc === 'string' ? parseUtcEpoch(utc) : null;
  if (epoch === null) return { kind: 'error', error: 'INVALID_UTC' };
  if (!isSupportedRuleset(ruleset)) return { kind: 'error', error: 'TZDB_UNAVAILABLE' };
  if (!Object.hasOwn(ruleset.zones, timezoneId))
    return { kind: 'error', error: 'UNKNOWN_TIMEZONE' };
  if (!utcInCoverage(ruleset, timezoneId, utc)) return { kind: 'error', error: 'TZDB_UNAVAILABLE' };
  const zone = ruleset.zones[timezoneId];
  let offset = zone.base_offset_seconds;
  for (const transition of zone.transitions) {
    const at = parseUtcEpoch(transition.at_utc);
    if (at !== null && epoch >= at) offset = transition.offset_seconds;
  }
  const localEpoch = epoch + offset;
  if (localEpoch < MIN_EPOCH || localEpoch > MAX_EPOCH)
    return { kind: 'error', error: 'TZDB_UNAVAILABLE' };
  const wall = wallPartsToString(civilFromEpoch(localEpoch));
  // Reuse normalization for coverage and the first/second occurrence of a fold.
  const first = normalize(wall, timezoneId, 'first', ruleset);
  if (first.kind === 'ok' && first.fire_at_utc === utc) {
    return {
      kind: 'ok',
      wall_time: wall,
      offset_seconds: first.offset_seconds,
      fold: first.fold,
      ruleset_id: first.ruleset_id,
    };
  }
  const second = normalize(wall, timezoneId, 'second', ruleset);
  if (second.kind === 'ok' && second.fire_at_utc === utc) {
    return {
      kind: 'ok',
      wall_time: wall,
      offset_seconds: second.offset_seconds,
      fold: second.fold,
      ruleset_id: second.ruleset_id,
    };
  }
  return { kind: 'error', error: 'TZDB_UNAVAILABLE' };
}
