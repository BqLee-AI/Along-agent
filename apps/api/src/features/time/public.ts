export { requireTimeContext, loadTimeContext, createTimeContext } from './context.js';
export type { TimeContext } from './context.js';
export { normalizeTime } from './normalize.js';
export type { TimeFailure, NormalizeTimeInput } from './normalize.js';

/** time-core's parser accepts second precision only. */
export function utcSecondIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
