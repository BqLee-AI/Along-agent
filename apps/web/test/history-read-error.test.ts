import { describe, expect, it } from 'bun:test';
import { readEnvelope } from '../src/shared/http/client';

describe('history public HTTP read errors', () => {
  it('retains HTTP category, public code and request_id for partial-resource feedback', async () => {
    let failure: unknown;
    try {
      await readEnvelope(
        Response.json(
          {
            code: 50301,
            data: null,
            msg: 'failed',
            error: {
              code: 'NOT_READY',
              message: 'History is temporarily unavailable',
              request_id: 'history-read-request',
            },
            request_id: 'history-read-request',
          },
          { status: 503 },
        ),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      status: 503,
      code: 'NOT_READY',
      requestId: 'history-read-request',
    });
  });
});
