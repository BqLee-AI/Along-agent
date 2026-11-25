import { httpStatusForError } from '@along/contracts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApplicationError, notReady, validationError } from '../platform/errors.js';
import { status } from 'elysia';
import { normalizeRequestId, type HttpAccess } from './access.js';
import { errorResponses } from './model.js';
import { unmatchedError } from './routing/fallback-controller.js';
import { writeFiniteResponse } from './transport/unread-upload.js';

// Shared HTTP envelope helpers (design/10 §1).
// Envelope code carries the HTTP status for transport errors; error.code is
// the symbolic name (UNAUTHENTICATED, NOT_FOUND, ...). Business 40xxxx codes
// land with confirm/reject in PR2.

export function requestIdOf(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  return normalizeRequestId(Array.isArray(incoming) ? incoming[0] : incoming);
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders?: Record<string, string>,
): void {
  writeFiniteResponse(
    res,
    status,
    {
      'content-type': 'application/json',
      'x-request-id': requestId,
      'cache-control': 'no-store',
      ...extraHeaders,
    },
    JSON.stringify(body),
  );
}

export function jsonResponse(
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-request-id': requestId,
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function okEnvelope<T>(data: T, requestId: string) {
  return { code: 0 as const, data, msg: 'ok' as const, error: null, request_id: requestId };
}

export function failEnvelope(err: ApplicationError, requestId: string) {
  return {
    code: err.code,
    data: null,
    msg: err.message,
    error: {
      code: err.errorCode,
      message: err.message,
      request_id: requestId,
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
    request_id: requestId,
  };
}

export function createErrorHandler(hasPool: boolean, access: HttpAccess) {
  return async ({
    code,
    error,
    request,
    set,
  }: {
    code: string | number;
    error: unknown;
    request: Request;
    set: { headers: Record<string, string | number | string[]> };
  }) => {
    let failure: ApplicationError;
    try {
      const cause = code === 'PARSE' && error instanceof Error ? error.cause : error;
      if (cause instanceof ApplicationError) failure = cause;
      else if (code === 'NOT_FOUND') failure = await unmatchedError(request, hasPool, access);
      else if (
        code === 'PARSE' ||
        (code === 'VALIDATION' &&
          !(error && typeof error === 'object' && 'type' in error && error.type === 'response'))
      )
        failure = validationError('invalid request body');
      else if (
        new URL(request.url).pathname.startsWith('/api/v1/auth/') ||
        new URL(request.url).pathname.startsWith('/api/v1/model-')
      )
        failure = notReady();
      else failure = new ApplicationError(500, 'INTERNAL_ERROR', 'internal error');
    } catch (caught) {
      failure = caught instanceof ApplicationError ? caught : notReady();
    }
    const details = failure.details;
    if (
      httpStatusForError(failure.code) === 429 &&
      details &&
      typeof details === 'object' &&
      'retry_after_seconds' in details &&
      typeof details.retry_after_seconds === 'number' &&
      Number.isFinite(details.retry_after_seconds) &&
      details.retry_after_seconds > 0
    )
      set.headers['retry-after'] = String(Math.ceil(details.retry_after_seconds));
    set.headers['x-request-id'] = access.requestId(request);
    set.headers['cache-control'] = 'no-store';
    return status(
      httpStatusForError(failure.code) as keyof typeof errorResponses,
      failEnvelope(failure, access.requestId(request)),
    );
  };
}
