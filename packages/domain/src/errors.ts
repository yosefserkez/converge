export const ErrorCode = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CSRF_REJECTED: 403,
  IDEMPOTENCY_KEY_REQUIRED: 422,
  IDEMPOTENCY_MISMATCH: 409,
  INVALID_INPUT: 422,
  INVALID_STATE: 409,
  STALE_APPROVAL: 409,
  STALE_FENCE: 409,
  STALE_MAIN: 409,
  TEXT_CONFLICT: 409,
  DEPENDENCY_CYCLE: 409,
  EVIDENCE_MISSING: 409,
  EVIDENCE_DIGEST_MISMATCH: 409,
  NOT_PROMOTABLE: 409,
  PROTECTED_PATH: 422,
  OUT_OF_SCOPE_EDIT: 422,
  BUDGET_EXCEEDED: 429,
  LIMIT_EXCEEDED: 429,
  ACTIVE_SESSION_EXISTS: 409,
  LIVE_DISABLED: 403,
  REPO_NOT_READY: 503,
  DEPENDENCY_UNAVAILABLE: 503,
  PREVIEW_EXPIRED: 410,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ErrorCode;

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['REPO_NOT_READY', 'DEPENDENCY_UNAVAILABLE', 'INTERNAL']);

export class DomainError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.status = ErrorCode[code];
    this.retryable = RETRYABLE.has(code);
  }
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    requestId: string;
    details: Record<string, unknown>;
  };
}

export function toEnvelope(err: DomainError, requestId: string): ErrorEnvelope {
  return {
    error: { code: err.code, message: err.message, retryable: err.retryable, requestId, details: err.details },
  };
}
