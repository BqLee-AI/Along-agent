import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../src/errors.js';
import { EnvelopeSchema } from '../src/envelope.js';

describe('errors', () => {
  it('APPROVAL_EXPIRED maps to HTTP 410', () => {
    expect(ERROR_CODES.APPROVAL_EXPIRED.http).toBe(410);
  });

  it('catalog covers design/10 §6 full table', () => {
    expect(ERROR_CODES.PRESENTATION_MISMATCH).toEqual({ code: 400001, http: 409 });
    expect(ERROR_CODES.APPROVAL_SUPERSEDED).toEqual({ code: 400003, http: 409 });
    expect(ERROR_CODES.TZDB_UNAVAILABLE).toEqual({ code: 400006, http: 503 });
    expect(ERROR_CODES.NOT_READY).toEqual({ code: 400011, http: 503 });
    expect(ERROR_CODES.BUDGET_EXCEEDED).toEqual({ code: 400008, http: 429 });
  });
});

describe('envelope', () => {
  it('rejects envelope missing request_id', () => {
    const parsed = EnvelopeSchema.safeParse({ code: 200, data: {}, msg: 'ok' });
    expect(parsed.success).toBe(false);
  });
});
