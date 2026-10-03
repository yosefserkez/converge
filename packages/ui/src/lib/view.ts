import type { ChangeIntent, Observation } from '@converge/domain';
import type { PublicReplay, SessionSnapshot } from '../dto.ts';

// One view model for the operator snapshot and the public replay.
// Element types come from the worker DTOs. The replay DTO is the common subset;
// operator-only fields are optional.

type Snap = SessionSnapshot;
type R = PublicReplay;
type RProposal = R['proposals'][number];
type RCandidate = R['candidates'][number];
type SProposal = Snap['proposals'][number];

export type ViewSource = 'operator' | 'replay' | 'sample';

export type ViewIntent = NonNullable<RProposal['intent']> & Partial<Pick<ChangeIntent, 'preservedInvariants' | 'reads' | 'writes'>>;

export type ViewRevision = RProposal['revisions'][number] & { diffEvidenceId?: string | null };

export type ViewProposal = Omit<RProposal, 'intent' | 'revisions'> & {
  intent: ViewIntent | null;
  revisions: ViewRevision[];
  progress?: SProposal['progress'];
  job?: SProposal['job'];
  intentVersion?: number;
  objective?: string;
};

export type ViewCheck = RCandidate['checks'][number] & { id?: string; evidenceId?: string | null };

export type ViewCandidate = Omit<RCandidate, 'checks'> & {
  checks: ViewCheck[];
  error?: Snap['candidates'][number]['error'];
};

export type ViewInteraction = Omit<R['interactions'][number], 'failedCheck'> & {
  failedCheck: { checkId: string; observations: Observation[] } | null;
  failedCheckRunId?: string | null;
};

export type ViewSession = Omit<R['session'], 'budget'> & {
  id?: string;
  reason?: string | null;
  budget: { spentMicroUsd: number; uncertainMicroUsd: number; ceilingMicroUsd: number; reservedMicroUsd?: number };
};

export interface ViewApproval {
  id?: string;
  candidateId?: string;
  decision: string;
  headSha: string;
  validationDigest: string;
  expectedMainSha?: string;
  createdAt: number;
  expiresAt?: number;
}

export interface ViewPromotion {
  id?: string;
  approvalId?: string;
  state: string;
  targetSha: string;
  beforeSha: string;
  observedRemoteSha: string | null;
}

export type ViewActivity = R['activity'][number] & { id?: string; attemptNo?: number };

export interface SessionView {
  source: ViewSource;
  readOnly: boolean;
  session: ViewSession;
  project: Snap['project'];
  proposals: ViewProposal[];
  candidates: ViewCandidate[];
  interactions: ViewInteraction[];
  approvals: ViewApproval[];
  promotions: ViewPromotion[];
  activity: ViewActivity[];
  jobs: Snap['jobs'];
  limits?: Snap['limits'];
  watermark?: number;
  replay?: { replayId: string; recordedAt: number; publishedAt: number; originalMode: string };
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function observationsOf(result: unknown): Observation[] {
  if (!result || typeof result !== 'object') return [];
  const obs = (result as { observations?: unknown }).observations;
  if (!Array.isArray(obs)) return [];
  return obs.filter((o): o is Observation => !!o && typeof o === 'object' && typeof (o as Observation).label === 'string');
}

export function fromSnapshot(s: SessionSnapshot, source: ViewSource = 'operator'): SessionView {
  return {
    source,
    readOnly: false,
    session: {
      id: s.session.id,
      objective: s.session.objective,
      mode: s.session.mode,
      status: s.session.status,
      baselineSha: s.session.baselineSha,
      expectedMainSha: s.session.expectedMainSha,
      createdAt: s.session.createdAt,
      finishedAt: s.session.finishedAt,
      taskSetDigest: s.session.taskSetDigest,
      policyDigest: s.session.policyDigest,
      harnessDigest: s.session.harnessDigest,
      modelId: s.session.modelId,
      reason: s.session.reason,
      budget: {
        spentMicroUsd: s.session.budget.spent,
        uncertainMicroUsd: s.session.budget.uncertain,
        reservedMicroUsd: s.session.budget.reserved,
        ceilingMicroUsd: s.session.budget.ceilingMicroUsd,
      },
    },
    project: s.project,
    proposals: s.proposals,
    candidates: s.candidates,
    interactions: s.interactions.map((i) => ({
      ...i,
      failedCheck: i.failedCheck ? { checkId: i.failedCheck.checkId, observations: observationsOf(i.failedCheck.result) } : null,
    })),
    approvals: s.approvals.map((a) => ({
      id: str(a.id),
      candidateId: str(a.candidate_id),
      decision: str(a.decision),
      headSha: str(a.head_sha),
      validationDigest: str(a.validation_digest),
      expectedMainSha: str(a.expected_main_sha),
      createdAt: Number(a.created_at),
      expiresAt: Number(a.expires_at),
    })),
    promotions: s.promotions.map((p) => ({
      id: str(p.id),
      approvalId: str(p.approval_id),
      state: str(p.state),
      targetSha: str(p.target_sha),
      beforeSha: str(p.before_sha),
      observedRemoteSha: strOrNull(p.observed_remote_sha),
    })),
    activity: s.activity,
    jobs: s.jobs,
    limits: s.limits,
    watermark: s.watermark,
  };
}

export function fromReplay(r: PublicReplay): SessionView {
  return {
    source: 'replay',
    readOnly: true,
    session: r.session,
    project: null,
    proposals: r.proposals,
    candidates: r.candidates,
    interactions: r.interactions.map((i) => ({
      ...i,
      failedCheck: i.failedCheck ? { checkId: i.failedCheck.checkId, observations: observationsOf(i.failedCheck) } : null,
    })),
    approvals: r.approvals.map((a) => ({ ...a, headSha: str(a.headSha), validationDigest: str(a.validationDigest), decision: str(a.decision), createdAt: Number(a.createdAt) })),
    promotions: r.promotions.map((p) => ({
      state: str(p.state),
      targetSha: str(p.targetSha),
      beforeSha: str(p.beforeSha),
      observedRemoteSha: strOrNull(p.observedRemoteSha),
    })),
    activity: r.activity,
    jobs: [],
    replay: { replayId: r.replayId, recordedAt: r.recordedAt, publishedAt: r.publishedAt, originalMode: r.originalMode },
  };
}

// ---------- lookups ----------

export const ACTIVE_STATUSES = new Set(['created', 'preflight', 'running', 'validating', 'repairing']);

export function isActive(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

/** Map each revision ID to its proposal. */
export function revisionIndex(view: Pick<SessionView, 'proposals'>) {
  const map = new Map<string, { proposal: ViewProposal; revision: ViewRevision }>();
  for (const p of view.proposals) for (const r of p.revisions) map.set(r.id, { proposal: p, revision: r });
  return map;
}

export function proposalName(p: Pick<ViewProposal, 'role' | 'title' | 'kind'>): string {
  if (p.kind === 'repair') return p.title;
  const role = p.role ?? '';
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : p.title;
}

/** The candidate a human can approve: newest promotable, passed, full-goal candidate. */
export function reviewCandidate(view: Pick<SessionView, 'candidates'>): ViewCandidate | null {
  const eligible = view.candidates.filter((c) => c.promotable && c.state === 'passed' && c.fullGoal && c.headSha);
  return eligible.length ? eligible.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a)) : null;
}

export function budgetExhausted(view: Pick<SessionView, 'session' | 'jobs' | 'proposals'>): boolean {
  const b = view.session.budget;
  if (b.ceilingMicroUsd <= 0) return false;
  const used = b.spentMicroUsd + (b.reservedMicroUsd ?? 0) + b.uncertainMicroUsd;
  if (used >= b.ceilingMicroUsd) return true;
  return view.jobs.some((j) => j.errorCode === 'BUDGET_EXCEEDED') || view.proposals.some((p) => p.job?.errorCode === 'BUDGET_EXCEEDED');
}
