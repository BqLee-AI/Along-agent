import { isUuid, notFound } from '../../platform/errors.js';

// Elysia's `path` preserves escapes; `params` are already percent-decoded.
// Index segments from zero, not counting the leading slash.
export function literalUuidAt(path: string, index: number, message: string): string {
  let slash = 0;
  for (let i = 0; i < index; i++) {
    slash = path.indexOf('/', slash + 1);
    if (slash === -1) throw notFound(message);
  }
  const end = path.indexOf('/', slash + 1);
  const value = path.slice(slash + 1, end === -1 ? undefined : end);
  if (!isUuid(value)) throw notFound(message);
  return value;
}
