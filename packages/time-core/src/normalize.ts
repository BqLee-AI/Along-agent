// Pure arithmetic normalize per docs/design/05-time-core.md §1/§4.
// No Date, no Date.now, no process.env, no Intl. Integer epoch math only.
import { daysSinceEpoch, formatUtc, parseUtcEpoch, parseWall } from './civil.js';
import type { AmbiguousCandidate, FoldChoice, NormalizeResult, TimeRuleset } from './types.js';

interface EpochZone {
  base_offset_seconds: number;
  transitions: { epoch: number; offset_seconds: number }[];
}

function toEpochZone(
  ruleset: TimeRuleset,
): { id: string; zones: Record<string, EpochZone> } | null {
  if (typeof ruleset !== 'object' || ruleset === null) return null;
  if (typeof ruleset.ruleset_id !== 'string' || typeof ruleset.tzdb_version !== 'string')
    return null;
  if (typeof ruleset.zones !== 'object' || ruleset.zones === null) return null;
  const zones: Record<string, EpochZone> = {};
  for (const [name, z] of Object.entries(ruleset.zones)) {
    if (typeof z?.base_offset_seconds !== 'number' || !Array.isArray(z?.transitions)) return null;
    const transitions: { epoch: number; offset_seconds: number }[] = [];
    for (const t of z.transitions) {
      const epoch = parseUtcEpoch(t.at_utc);
      if (epoch === null || typeof t.offset_seconds !== 'number') return null;
      transitions.push({ epoch, offset_seconds: t.offset_seconds });
    }
    transitions.sort((a, b) => a.epoch - b.epoch);
    zones[name] = { base_offset_seconds: z.base_offset_seconds, transitions };
  }
  return { id: ruleset.ruleset_id, zones };
}

function offsetFor(zone: EpochZone, epoch: number): number {
  let offset = zone.base_offset_seconds;
  for (const t of zone.transitions) {
    if (epoch >= t.epoch) offset = t.offset_seconds;
    else break;
  }
  return offset;
}

export function normalize(
  wallTime: string,
  timezoneId: string,
  foldChoice: FoldChoice,
  ruleset: TimeRuleset,
): NormalizeResult {
  const parsed = toEpochZone(ruleset);
  if (parsed === null) return { kind: 'error', error: 'TZDB_UNAVAILABLE' };
  const zone = parsed.zones[timezoneId];
  if (!zone) return { kind: 'error', error: 'UNKNOWN_TIMEZONE', ruleset_id: parsed.id };
  const wall = parseWall(wallTime);
  if (wall === null)
    return { kind: 'error', error: 'NONEXISTENT_LOCAL_TIME', ruleset_id: parsed.id };
  const wallSeconds =
    daysSinceEpoch(wall.y, wall.mo, wall.d) * 86400 + wall.h * 3600 + wall.mi * 60 + wall.s;

  // Candidate offset universe: base + every distinct transition offset.
  const offsets: Record<number, true> = { [zone.base_offset_seconds]: true };
  for (const t of zone.transitions) offsets[t.offset_seconds] = true;
  const matches: { offset: number; epoch: number }[] = [];
  for (const key of Object.keys(offsets)) {
    const offset = Number(key);
    const epoch = wallSeconds - offset;
    if (offsetFor(zone, epoch) === offset) matches.push({ offset, epoch });
  }
  matches.sort((a, b) => a.epoch - b.epoch);

  if (matches.length === 0) {
    return { kind: 'error', error: 'NONEXISTENT_LOCAL_TIME', ruleset_id: parsed.id };
  }
  if (matches.length === 1) {
    const single = matches[0];
    return {
      kind: 'ok',
      fire_at_utc: formatUtc(single.epoch),
      offset_seconds: single.offset,
      fold: 0,
      ruleset_id: parsed.id,
    };
  }
  const first: AmbiguousCandidate = {
    fold_choice: 'first',
    offset_seconds: matches[0].offset,
    fire_at_utc: formatUtc(matches[0].epoch),
  };
  const second: AmbiguousCandidate = {
    fold_choice: 'second',
    offset_seconds: matches[1].offset,
    fire_at_utc: formatUtc(matches[1].epoch),
  };
  if (foldChoice === 'none') {
    return {
      kind: 'error',
      error: 'AMBIGUOUS_LOCAL_TIME',
      candidates: [first, second],
      ruleset_id: parsed.id,
    };
  }
  const chosen = foldChoice === 'first' ? first : second;
  return {
    kind: 'ok',
    fire_at_utc: chosen.fire_at_utc,
    offset_seconds: chosen.offset_seconds,
    fold: foldChoice === 'first' ? 0 : 1,
    ruleset_id: parsed.id,
  };
}

export { formatUtc };
