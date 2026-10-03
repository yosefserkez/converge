import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  CandidateState,
  DomainError,
  type Entity,
  type EntityStates,
  InteractionState,
  isActiveSession,
  isTerminal,
  JobStatus,
  ProposalStatus,
  retryJob,
  SessionStatus,
} from '../src/index.ts';

type Case<E extends Entity> = [E, EntityStates[E], EntityStates[E]];
type AnyCase = Case<'session'> | Case<'proposal'> | Case<'candidate'> | Case<'job'> | Case<'interaction'>;

const legal: AnyCase[] = [
  ['session', 'created', 'preflight'],
  ['session', 'preflight', 'running'],
  ['session', 'running', 'validating'],
  ['session', 'validating', 'repairing'],
  ['session', 'repairing', 'validating'],
  ['session', 'validating', 'ready'],
  ['session', 'ready', 'promoted'],
  ['session', 'running', 'needs_attention'],
  ['session', 'repairing', 'failed'],
  ['session', 'created', 'cancelled'],
  ['session', 'ready', 'cancelled'],
  ['proposal', 'pending', 'working'],
  ['proposal', 'working', 'sealed'],
  ['proposal', 'working', 'blocked'],
  ['proposal', 'working', 'cancelled'],
  ['candidate', 'planned', 'assembling'],
  ['candidate', 'assembling', 'testing'],
  ['candidate', 'testing', 'passed'],
  ['candidate', 'testing', 'failed'],
  ['candidate', 'assembling', 'text_conflict'],
  ['candidate', 'assembling', 'error'],
  ['candidate', 'planned', 'cancelled'],
  ['candidate', 'testing', 'error'],
  ['job', 'queued', 'leased'],
  ['job', 'leased', 'running'],
  ['job', 'running', 'succeeded'],
  ['job', 'running', 'failed'],
  ['job', 'running', 'cancelled'],
  ['job', 'running', 'expired'],
  ['job', 'failed', 'queued'],
  ['job', 'expired', 'queued'],
  ['interaction', 'predicted', 'confirmed'],
  ['interaction', 'predicted', 'unknown'],
  ['interaction', 'confirmed', 'resolved'],
];

const illegal: AnyCase[] = [
  ['session', 'created', 'running'],
  ['session', 'running', 'ready'],
  ['session', 'validating', 'promoted'],
  ['session', 'promoted', 'cancelled'],
  ['session', 'failed', 'running'],
  ['session', 'cancelled', 'created'],
  ['proposal', 'sealed', 'working'],
  ['proposal', 'pending', 'sealed'],
  ['proposal', 'cancelled', 'working'],
  ['candidate', 'planned', 'testing'],
  ['candidate', 'failed', 'passed'],
  ['candidate', 'passed', 'failed'],
  ['candidate', 'testing', 'text_conflict'],
  ['candidate', 'text_conflict', 'cancelled'],
  ['job', 'queued', 'running'],
  ['job', 'succeeded', 'queued'],
  ['job', 'cancelled', 'queued'],
  ['job', 'failed', 'running'],
  ['interaction', 'predicted', 'resolved'],
  ['interaction', 'resolved', 'confirmed'],
  ['interaction', 'confirmed', 'predicted'],
];

describe('transitions', () => {
  it.each(legal)('%s: %s -> %s is legal', (entity, from, to) => {
    expect(canTransition(entity, from as never, to as never)).toBe(true);
    expect(() => assertTransition(entity, from as never, to as never)).not.toThrow();
  });

  it.each(illegal)('%s: %s -> %s is illegal', (entity, from, to) => {
    expect(canTransition(entity, from as never, to as never)).toBe(false);
    try {
      assertTransition(entity, from as never, to as never);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe('INVALID_STATE');
    }
  });

  it('every active session state can exit to needs_attention, failed, or cancelled', () => {
    for (const s of SessionStatus.options.filter(isActiveSession)) {
      for (const exit of ['needs_attention', 'failed', 'cancelled'] as const) expect(canTransition('session', s, exit)).toBe(true);
    }
  });

  it('every nonterminal candidate state can be cancelled or error', () => {
    for (const s of CandidateState.options.filter((s) => !isTerminal('candidate', s))) {
      expect(canTransition('candidate', s, 'cancelled')).toBe(true);
      expect(canTransition('candidate', s, 'error')).toBe(true);
    }
  });

  it('terminal helpers', () => {
    expect(SessionStatus.options.filter((s) => isTerminal('session', s))).toEqual(['promoted', 'failed', 'cancelled']);
    expect(ProposalStatus.options.filter((s) => isTerminal('proposal', s))).toEqual(['sealed', 'cancelled']);
    expect(CandidateState.options.filter((s) => isTerminal('candidate', s))).toEqual([
      'passed',
      'failed',
      'text_conflict',
      'error',
      'cancelled',
    ]);
    expect(JobStatus.options.filter((s) => isTerminal('job', s))).toEqual(['succeeded', 'cancelled']);
    expect(InteractionState.options.filter((s) => isTerminal('interaction', s))).toEqual(['resolved']);
  });
});

describe('retryJob', () => {
  it('creates a new attempt with a larger fence', () => {
    expect(retryJob({ status: 'failed', attemptNo: 1, fence: 7 })).toEqual({ status: 'queued', attemptNo: 2, fence: 8 });
    expect(retryJob({ status: 'expired', attemptNo: 2, fence: 8 }, 20)).toEqual({ status: 'queued', attemptNo: 3, fence: 20 });
  });

  it('rejects a non-growing fence and non-retryable states', () => {
    expect(() => retryJob({ status: 'failed', attemptNo: 1, fence: 7 }, 7)).toThrow(DomainError);
    expect(() => retryJob({ status: 'succeeded', attemptNo: 1, fence: 7 })).toThrow(/cannot move/);
    expect(() => retryJob({ status: 'running', attemptNo: 1, fence: 7 })).toThrow(/cannot move/);
  });
});

describe('session resume after a human retry', () => {
  it('needs_attention can resume into the phase that still has work', () => {
    for (const to of ['running', 'validating', 'repairing'] as const) expect(canTransition('session', 'needs_attention', to)).toBe(true);
    expect(canTransition('session', 'needs_attention', 'ready')).toBe(false);
    expect(canTransition('session', 'needs_attention', 'promoted')).toBe(false);
  });
});
