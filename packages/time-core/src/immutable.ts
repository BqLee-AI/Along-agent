// Deterministic value helpers; no runtime or application dependencies.
export function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}

export function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (
    actual === null ||
    expected === null ||
    typeof actual !== 'object' ||
    typeof expected !== 'object'
  )
    return false;
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  const keys = Object.keys(e);
  return (
    Object.keys(a).length === keys.length &&
    keys.every((key) => Object.hasOwn(a, key) && sameValue(a[key], e[key]))
  );
}
