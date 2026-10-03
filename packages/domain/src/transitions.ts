import { DomainError } from './errors.ts';
import type { CandidateState, InteractionState, JobStatus, ProposalStatus, SessionStatus } from './schemas.ts';

// Explicit state machines (brief §6 "State transitions"). Never assign a
// status string directly; go through assertTransition.

export interface EntityStates {
  session: SessionStatus;
  proposal: ProposalStatus;
  candidate: CandidateState;
  job: JobStatus;
  interaction: InteractionState;
}
export type Entity = keyof EntityStates;

type Table<S extends string> = Readonly<Record<S, readonly S[]>>;

const SESSION_ACTIVE = ['created', 'preflight', 'running', 'validating', 'repairing', 'ready'] as const;
const SESSION_EXITS = ['needs_attention', 'failed', 'cancelled'] as const;

const SESSION: Table<SessionStatus> = {
  created: ['preflight', ...SESSION_EXITS],
  preflight: ['running', ...SESSION_EXITS],
  running: ['validating', ...SESSION_EXITS],
  validating: ['repairing', 'ready', ...SESSION_EXITS],
  repairing: ['validating', ...SESSION_EXITS],
  ready: ['promoted', ...SESSION_EXITS],
  // Parked for a human; can only be closed out.
  needs_attention: ['failed', 'cancelled'],
  promoted: [],
  failed: [],
  cancelled: [],
};

const PROPOSAL: Table<ProposalStatus> = {
  pending: ['working', 'cancelled'],
  working: ['sealed', 'blocked', 'cancelled'],
  blocked: ['cancelled'],
  // New work after sealing creates a new immutable revision, never an edit.
  sealed: [],
  cancelled: [],
};

const CANDIDATE_EXITS = ['cancelled', 'error'] as const;
const CANDIDATE: Table<CandidateState> = {
  planned: ['assembling', ...CANDIDATE_EXITS],
  assembling: ['testing', 'text_conflict', ...CANDIDATE_EXITS],
  testing: ['passed', 'failed', ...CANDIDATE_EXITS],
  passed: [],
  failed: [],
  text_conflict: [],
  error: [],
  cancelled: [],
};

const JOB: Table<JobStatus> = {
  queued: ['leased', 'cancelled'],
  leased: ['running', 'cancelled', 'expired'],
  running: ['succeeded', 'failed', 'cancelled', 'expired'],
  // failed/expired -> queued is a retry: a new attempt with a larger fence (see retryJob).
  failed: ['queued'],
  expired: ['queued'],
  succeeded: [],
  cancelled: [],
};

const INTERACTION: Table<InteractionState> = {
  predicted: ['confirmed', 'unknown'],
  unknown: ['confirmed'],
  confirmed: ['resolved'],
  resolved: [],
};

const TABLES: { [E in Entity]: Table<EntityStates[E]> } = {
  session: SESSION,
  proposal: PROPOSAL,
  candidate: CANDIDATE,
  job: JOB,
  interaction: INTERACTION,
};

export function allowedTransitions<E extends Entity>(entity: E, from: EntityStates[E]): readonly EntityStates[E][] {
  const table: Table<EntityStates[E]> = TABLES[entity];
  return table[from] ?? [];
}

export function canTransition<E extends Entity>(entity: E, from: EntityStates[E], to: EntityStates[E]): boolean {
  return allowedTransitions(entity, from).includes(to);
}

export function assertTransition<E extends Entity>(entity: E, from: EntityStates[E], to: EntityStates[E]): void {
  if (!canTransition(entity, from, to)) {
    throw new DomainError('INVALID_STATE', `${entity} cannot move from ${from} to ${to}`, { entity, from, to });
  }
}

/** No outgoing transitions at all. Job failed/expired are not terminal: they can retry. */
export function isTerminal<E extends Entity>(entity: E, state: EntityStates[E]): boolean {
  return allowedTransitions(entity, state).length === 0;
}

export function isActiveSession(status: SessionStatus): boolean {
  return (SESSION_ACTIVE as readonly string[]).includes(status);
}

/** A job attempt is finished once it reaches any of these; retries start a new attempt. */
export const JOB_ATTEMPT_FINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

export interface JobAttemptState {
  status: JobStatus;
  attemptNo: number;
  fence: number;
}

/**
 * Retry a failed or expired job as a new attempt. The fence must strictly grow;
 * pass the coordinator's next monotonic fence when it is global.
 */
export function retryJob(current: JobAttemptState, nextFence: number = current.fence + 1): JobAttemptState {
  assertTransition('job', current.status, 'queued');
  if (!Number.isInteger(nextFence) || nextFence <= current.fence) {
    throw new DomainError('STALE_FENCE', `retry fence ${nextFence} must exceed ${current.fence}`, {
      fence: current.fence,
      nextFence,
    });
  }
  return { status: 'queued', attemptNo: current.attemptNo + 1, fence: nextFence };
}
