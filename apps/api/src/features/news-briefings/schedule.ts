import { normalize, utcInCoverage } from '@along/time-core';
import { utcSecondIso, type TimeContext } from '../time/public.js';

export function dailySlot(clock: Date, timezone: string, context: TimeContext) {
  if (!context.available || !utcInCoverage(context.ruleset, timezone, utcSecondIso(clock)))
    return null;
  const zone = context.ruleset.zones[timezone];
  let offset = zone.base_offset_seconds;
  for (const transition of zone.transitions) {
    if (Date.parse(transition.at_utc) > clock.getTime()) break;
    offset = transition.offset_seconds;
  }
  const date = new Date(clock.getTime() + offset * 1000).toISOString().slice(0, 10);
  const wall = `${date}T08:00:00`;
  const slot = normalize(wall, timezone, 'first', context.ruleset);
  if (slot.kind === 'ok') return { date, cutoff: new Date(slot.fire_at_utc) };
  if (slot.kind !== 'error' || slot.error !== 'NONEXISTENT_LOCAL_TIME') return null;
  offset = zone.base_offset_seconds;
  const target = Date.parse(`${wall}Z`);
  for (const transition of zone.transitions) {
    const utc = Date.parse(transition.at_utc);
    const nextOffset = transition.offset_seconds;
    if (target >= utc + offset * 1000 && target < utc + nextOffset * 1000)
      return { date, cutoff: new Date(utc) };
    offset = nextOffset;
  }
  return null;
}
