import type {
  CandidateDetail,
  ConfigDto,
  EventsPage,
  EvidenceDto,
  ProjectSummary,
  ProposalDetail,
  SessionListItem,
  SessionSnapshot,
} from '@converge/ui';

/** The error envelope of the control API, plus network failures (status 0). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details: unknown;

  constructor(a: { status: number; code: string; message: string; retryable: boolean; requestId?: string | null; details?: unknown }) {
    super(a.message);
    this.name = 'ApiError';
    this.status = a.status;
    this.code = a.code;
    this.retryable = a.retryable;
    this.requestId = a.requestId ?? null;
    this.details = a.details ?? null;
  }
}

export interface Api {
  readonly sample: boolean;
  getConfig(): Promise<ConfigDto>;
  getProject(): Promise<ProjectSummary>;
  listSessions(): Promise<{ sessions: SessionListItem[] }>;
  getSnapshot(sessionId: string): Promise<SessionSnapshot>;
  getEvents(sessionId: string, after: number, limit: number): Promise<EventsPage>;
  getProposal(id: string): Promise<ProposalDetail>;
  getCandidate(id: string): Promise<CandidateDetail>;
  getEvidence(id: string): Promise<EvidenceDto>;
  /** POST a domain command. The caller owns the Idempotency-Key. */
  command<T>(path: string, body: object, idempotencyKey: string): Promise<T>;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      redirect: 'manual',
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiError({
      status: 0,
      code: 'NETWORK',
      message: 'The control plane did not respond. Check the connection. If your sign-in expired, reload the page.',
      retryable: true,
    });
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new ApiError({ status: 401, code: 'SIGN_IN_REQUIRED', message: 'Your sign-in expired. Reload the page to sign in again.', retryable: false });
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string; retryable?: boolean; requestId?: string; details?: unknown } } | null)?.error;
    throw new ApiError({
      status: res.status,
      code: e?.code ?? `HTTP_${res.status}`,
      message: e?.message ?? defaultMessage(res.status),
      retryable: e?.retryable ?? (res.status >= 500 || res.status === 429),
      requestId: e?.requestId ?? res.headers.get('X-Request-Id'),
      details: e?.details,
    });
  }
  if (body === null) {
    throw new ApiError({ status: res.status, code: 'BAD_RESPONSE', message: 'The control plane sent a response that is not JSON.', retryable: true });
  }
  return body as T;
}

function defaultMessage(status: number): string {
  if (status === 401) return 'Sign in to use the control plane.';
  if (status === 403) return 'Your account is not an authorized operator.';
  if (status === 404) return 'The control plane did not find this resource.';
  if (status === 409) return 'The state changed. Refresh and try again.';
  if (status === 422) return 'The request data is not valid.';
  if (status === 429) return 'A policy limit stopped this request. Wait and try again.';
  if (status === 503) return 'A dependency of the control plane is unavailable. Try again soon.';
  return `The request failed with status ${status}.`;
}

const enc = encodeURIComponent;

export const httpApi: Api = {
  sample: false,
  getConfig: () => request('/api/config'),
  getProject: () => request('/api/project'),
  listSessions: () => request('/api/sessions'),
  getSnapshot: (id) => request(`/api/sessions/${enc(id)}`),
  getEvents: (id, after, limit) => request(`/api/sessions/${enc(id)}/events?after=${after}&limit=${limit}`),
  getProposal: (id) => request(`/api/proposals/${enc(id)}`),
  getCandidate: (id) => request(`/api/candidates/${enc(id)}`),
  getEvidence: (id) => request(`/api/evidence/${enc(id)}`),
  command: (path, body, idempotencyKey) =>
    request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    }),
};

/** A new Idempotency-Key for one user action. */
export function newIdempotencyKey(): string {
  return `ui-${crypto.randomUUID()}`;
}
