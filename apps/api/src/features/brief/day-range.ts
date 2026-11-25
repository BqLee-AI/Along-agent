import { normalize, utcInCoverage } from '@along/time-core';
import { ApplicationError, validationError } from '../../platform/errors.js';
import { utcSecondIso, type TimeContext } from '../time/public.js';

export function briefDayRange(
  date: string | undefined,
  timezoneId: string,
  now: Date,
  context: TimeContext | undefined,
): { date: string; start: string; end: string } {
  let offsetSeconds = 0;
  if (timezoneId !== 'UTC') {
    if (!context?.available)
      throw new ApplicationError(400006, 'TZDB_UNAVAILABLE', '时区规则库暂不可用。');
    const zone = context.ruleset.zones[timezoneId];
    if (!Object.hasOwn(context.ruleset.zones, timezoneId))
      throw validationError('confirmed timezone is not supported');
    if (!date) {
      const nowText = utcSecondIso(now);
      if (!utcInCoverage(context.ruleset, timezoneId, nowText))
        throw new ApplicationError(400006, 'TZDB_UNAVAILABLE', '日期超出时区规则范围。');
      offsetSeconds = zone.base_offset_seconds;
      for (const transition of zone.transitions) {
        if (Date.parse(transition.at_utc) > now.getTime()) break;
        offsetSeconds = transition.offset_seconds;
      }
    }
  }
  const day = date ?? new Date(now.getTime() + offsetSeconds * 1000).toISOString().slice(0, 10);
  const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  if (timezoneId === 'UTC')
    return { date: day, start: `${day}T00:00:00Z`, end: `${nextDay}T00:00:00Z` };
  if (!context?.available)
    throw new ApplicationError(400006, 'TZDB_UNAVAILABLE', '时区规则库暂不可用。');
  const zone = context.ruleset.zones[timezoneId];
  const boundaries = [day, nextDay].map((value) => {
    const wall = `${value}T00:00:00`;
    if (wall === zone.coverage.wall_end) return zone.coverage.utc_end;
    const result = normalize(wall, timezoneId, 'first', context.ruleset);
    if (result.kind !== 'ok')
      throw new ApplicationError(400006, 'TZDB_UNAVAILABLE', '无法确定该日时区边界。');
    return result.fire_at_utc;
  });
  return { date: day, start: boundaries[0]!, end: boundaries[1]! };
}
