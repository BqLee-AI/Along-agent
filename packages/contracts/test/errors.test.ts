import { describe, expect, it } from 'bun:test';
import { ERROR_CODES, httpStatusForError } from '../src/errors.js';
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

  it.each([
    [400001, 409],
    [400002, 410],
    [400006, 503],
    [400008, 429],
    [422, 422],
    [500, 500],
    [502, 502],
    [503, 503],
  ])('preserves the wire status of numeric error code %i', (code, status) => {
    expect(httpStatusForError(code)).toBe(status);
  });
});

describe('envelope', () => {
  it('accepts the success wire envelope with a null error while retaining typed failure validation', () => {
    const success = EnvelopeSchema.parse({
      code: 0,
      data: { csrf_token: null },
      msg: 'ok',
      error: null,
      request_id: 'success-request',
    });
    expect(success.error).toBeNull();
    expect(
      EnvelopeSchema.safeParse({
        code: 1,
        data: null,
        msg: 'failure',
        error: { code: 'INTERNAL_ERROR' },
        request_id: 'failure-request',
      }).success,
    ).toBe(false);
  });

  it('rejects envelope missing request_id', () => {
    const parsed = EnvelopeSchema.safeParse({ code: 200, data: {}, msg: 'ok' });
    expect(parsed.success).toBe(false);
  });
});
