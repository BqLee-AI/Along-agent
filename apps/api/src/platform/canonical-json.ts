import { stateConflict } from './errors.js';

/** Compare or digest plain JSON without depending on object key order. */
export function canonicalJson(value: unknown, errorMessage: string): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry, errorMessage)).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], errorMessage)}`,
      )
      .join(',')}}`;
  throw stateConflict(errorMessage);
}
