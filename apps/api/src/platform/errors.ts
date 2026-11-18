export class ApplicationError extends Error {
  constructor(
    public code: number,
    public errorCode: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function unauthorized(message = 'unauthorized'): ApplicationError {
  return new ApplicationError(401, 'UNAUTHENTICATED', message);
}

export function forbidden(message = 'forbidden'): ApplicationError {
  return new ApplicationError(403, 'FORBIDDEN', message);
}

// CSRF guard failure (issue #27): POST without a valid X-CSRF-Token.
// Same envelope code shape as FORBIDDEN, distinguished by details.reason.
export function csrfMismatch(): ApplicationError {
  return new ApplicationError(403, 'FORBIDDEN', 'csrf mismatch', {
    reason: 'CSRF_MISMATCH',
  });
}

export function notFound(message = 'not found'): ApplicationError {
  return new ApplicationError(404, 'NOT_FOUND', message);
}

export function validationError(message: string): ApplicationError {
  return new ApplicationError(400, 'VALIDATION_ERROR', message);
}

// Confirm-gate business errors (PR2): numeric 40xxxx codes per contracts
// catalog (docs/design/10 §6, S0 frozen). HTTP status from the catalog.
export function presentationMismatch(message = '所见与存档不一致'): ApplicationError {
  return new ApplicationError(400001, 'PRESENTATION_MISMATCH', message);
}

export function approvalExpired(message = 'approval expired'): ApplicationError {
  return new ApplicationError(400002, 'APPROVAL_EXPIRED', message);
}

export function approvalSuperseded(successorApprovalId: string | null): ApplicationError {
  return new ApplicationError(400003, 'APPROVAL_SUPERSEDED', 'approval superseded', {
    successor_approval_id: successorApprovalId,
  });
}

export function stateConflict(message = 'state conflict', details?: unknown): ApplicationError {
  return new ApplicationError(400010, 'STATE_CONFLICT', message, details);
}

export function notReady(message = 'database unavailable'): ApplicationError {
  return new ApplicationError(503, 'NOT_READY', message);
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
