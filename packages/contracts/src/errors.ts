// Error catalog: docs/design/10-api-and-stream-design.md §6 (S0 frozen).
// Envelope error.code is numeric 40xxxx; `name` carries the symbolic name.

export const ERROR_CODES = {
  PRESENTATION_MISMATCH: { code: 400001, http: 409 },
  APPROVAL_EXPIRED: { code: 400002, http: 410 },
  APPROVAL_SUPERSEDED: { code: 400003, http: 409 },
  NONEXISTENT_LOCAL_TIME: { code: 400004, http: 422 },
  AMBIGUOUS_LOCAL_TIME: { code: 400005, http: 422 },
  TZDB_UNAVAILABLE: { code: 400006, http: 503 },
  UNKNOWN_TIMEZONE: { code: 400007, http: 422 },
  BUDGET_EXCEEDED: { code: 400008, http: 429 },
  IDEMPOTENT_REPLAY: { code: 400009, http: 200 },
  STATE_CONFLICT: { code: 400010, http: 409 },
  NOT_READY: { code: 400011, http: 503 },
} as const;

export type ErrorName = keyof typeof ERROR_CODES;
export type ErrorEntry = (typeof ERROR_CODES)[ErrorName];

const statusByCode = new Map<number, number>(
  Object.values(ERROR_CODES).map(({ code, http }) => [code, http]),
);

// Legacy numeric codes are already HTTP statuses. Catalog codes remain
// distinct from symbolic names, which can occur under several legacy codes.
export function httpStatusForError(code: number): number {
  return statusByCode.get(code) ?? code;
}
