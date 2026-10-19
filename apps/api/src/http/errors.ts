import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

// Shared HTTP envelope helpers (design/10 §1).
// Envelope code carries the HTTP status for transport errors; error.code is
// the symbolic name (UNAUTHENTICATED, NOT_FOUND, ...). Business 40xxxx codes
// land with confirm/reject in PR2.

export class HttpError extends Error {
  constructor(
    public httpStatus: number,
    public code: number,
    public errorCode: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

// Bounded: the id is echoed in every envelope and persisted in checkpoints,
// whose protocol schema caps request_id at 200 chars.
export function requestIdOf(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  const first = Array.isArray(incoming) ? incoming[0] : incoming;
  const value = first?.trim() ?? '';
  return value !== '' && value.length <= 200 ? value : randomUUID();
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-request-id': requestId,
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

export function okEnvelope(data: unknown, requestId: string): unknown {
  return { code: 0, data, msg: 'ok', error: null, request_id: requestId };
}

export function failEnvelope(err: HttpError, requestId: string): unknown {
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

export function unauthorized(message = 'unauthorized'): HttpError {
  return new HttpError(401, 401, 'UNAUTHENTICATED', message);
}

export function forbidden(message = 'forbidden'): HttpError {
  return new HttpError(403, 403, 'FORBIDDEN', message);
}

// CSRF guard failure (issue #27): POST without a valid X-CSRF-Token.
// Same envelope code shape as FORBIDDEN, distinguished by details.reason.
export function csrfMismatch(): HttpError {
  return new HttpError(403, 403, 'FORBIDDEN', 'csrf mismatch', {
    reason: 'CSRF_MISMATCH',
  });
}

export function notFound(message = 'not found'): HttpError {
  return new HttpError(404, 404, 'NOT_FOUND', message);
}

export function validationError(message: string): HttpError {
  return new HttpError(400, 400, 'VALIDATION_ERROR', message);
}

// Confirm-gate business errors (PR2): numeric 40xxxx codes per contracts
// catalog (docs/design/10 §6, S0 frozen). HTTP status from the catalog.
export function presentationMismatch(message = '所见与存档不一致'): HttpError {
  return new HttpError(409, 400001, 'PRESENTATION_MISMATCH', message);
}

export function approvalExpired(message = 'approval expired'): HttpError {
  return new HttpError(410, 400002, 'APPROVAL_EXPIRED', message);
}

export function approvalSuperseded(successorApprovalId: string | null): HttpError {
  return new HttpError(409, 400003, 'APPROVAL_SUPERSEDED', 'approval superseded', {
    successor_approval_id: successorApprovalId,
  });
}

export function stateConflict(message = 'state conflict', details?: unknown): HttpError {
  return new HttpError(409, 400010, 'STATE_CONFLICT', message, details);
}

export function notReady(message = 'database unavailable'): HttpError {
  return new HttpError(503, 503, 'NOT_READY', message);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function encodeCursor(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}
