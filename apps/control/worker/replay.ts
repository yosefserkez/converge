import type { SessionSnapshot } from './coordinator/queries.ts';

/**
 * Explicit whitelist transformation from private state to the public replay DTO.
 * Nothing is copied by default: credentials, provider messages, Access identity,
 * account identifiers, and unlisted fields never reach the output.
 */
const PUBLIC_EVENT_TYPES = new Set([
  'session.created', 'session.started', 'session.running', 'session.validating', 'session.repairing', 'session.ready',
  'session.promoted', 'session.needs_attention', 'session.cancelled', 'session.failed',
  'agent.started', 'agent.progress', 'agent.blocked', 'intent.updated', 'revision.sealed',
  'interaction.predicted', 'interaction.confirmed', 'interaction.resolved',
  'candidate.planned', 'candidate.assembled', 'candidate.testing', 'candidate.passed', 'candidate.failed',
  'candidate.text_conflict', 'candidate.error', 'candidate.validated', 'check.failed', 'check.error',
  'repair.assigned', 'approval.recorded', 'promotion.queued', 'promotion.succeeded', 'promotion.stale', 'promotion.failed',
  'deploy.verified', 'deploy.version-mismatch', 'deploy.checks-failed',
]);

const PUBLIC_PAYLOAD_KEYS = new Set([
  'from', 'to', 'reason', 'mode', 'baselineSha', 'version', 'digest', 'contractChanges', 'assumptions', 'revisionId',
  'revisionNo', 'headSha', 'treeSha', 'changedPaths', 'warnings', 'dependencies', 'kind', 'state', 'contractKey',
  'explanation', 'candidateId', 'checkId', 'label', 'members', 'anchor', 'manifestDigest', 'validationDigest',
  'failedCount', 'failedCandidateId', 'failedLabel', 'checks', 'decision', 'targetSha', 'observedRemoteSha',
  'expectedMainSha', 'reconciled', 'message', 'attemptNo', 'agents', 'url', 'expectedCommit', 'observedVersion', 'failedChecks',
]);

type Event = { seq: number; type: string; entityType: string; entityId: string; payload: Record<string, unknown>; visibility: string; createdAt: number };

function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = obj[k];
  return out;
}

const scrubText = (s: string) => s.replace(/art_v1_[0-9a-f]{40}(\?expires=\d+)?/g, '[redacted-token]').replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-key]');

export function redactReplay(args: { replayId: string; snapshot: SessionSnapshot; events: Event[]; publishedAt: number }) {
  const { snapshot: s } = args;
  return {
    schemaVersion: 1 as const,
    replayId: args.replayId,
    publishedAt: args.publishedAt,
    recordedAt: s.session.createdAt,
    originalMode: s.session.mode,
    session: {
      ...pick(s.session, ['objective', 'mode', 'status', 'baselineSha', 'expectedMainSha', 'createdAt', 'finishedAt', 'taskSetDigest', 'policyDigest', 'harnessDigest', 'modelId']),
      budget: { spentMicroUsd: s.session.budget.spent, uncertainMicroUsd: s.session.budget.uncertain, ceilingMicroUsd: s.session.budget.ceilingMicroUsd },
    },
    proposals: s.proposals.map((p) => ({
      ...pick(p, ['id', 'title', 'kind', 'role', 'status', 'baseCandidateId', 'editablePaths', 'capabilityIds']),
      summary: p.summary ? scrubText(p.summary) : null,
      intent: p.intent
        ? { objective: scrubText(p.intent.objective), contractChanges: p.intent.contractChanges, assumptions: p.intent.assumptions, affectedPaths: p.intent.affectedPaths }
        : null,
      revisions: p.revisions.map((r) => pick(r, ['id', 'revisionNo', 'baseSha', 'headSha', 'treeSha', 'intentDigest', 'dependencies', 'createdAt'])),
    })),
    candidates: s.candidates.map((c) => ({
      ...pick(c, ['id', 'label', 'state', 'headSha', 'treeSha', 'members', 'anchorCandidateId', 'capabilities', 'fullGoal', 'promotable', 'validationDigest', 'manifestDigest', 'createdAt']),
      checks: c.checks.map((k) => pick(k, ['checkId', 'status', 'applicable', 'applicabilityReason', 'assertionCount', 'failedCount', 'attemptNo'])),
    })),
    interactions: s.interactions.map((i) => ({
      ...pick(i, ['id', 'kind', 'state', 'contractKey', 'leftProposalId', 'rightProposalId', 'explanation', 'failedCandidateId', 'resolvedCandidateId']),
      failedCheck: i.failedCheck
        ? {
            checkId: i.failedCheck.checkId,
            observations: ((i.failedCheck.result as { observations?: unknown[] }).observations ?? []).slice(0, 24),
          }
        : null,
    })),
    promotions: s.promotions.map((p) => ({ state: p.state, targetSha: p.target_sha, beforeSha: p.before_sha, observedRemoteSha: p.observed_remote_sha })),
    approvals: s.approvals.map((a) => ({ decision: a.decision, headSha: a.head_sha, validationDigest: a.validation_digest, createdAt: a.created_at })),
    activity: s.activity.map((a) => pick(a, ['proposalId', 'kind', 'label', 'startedAt', 'finishedAt'])),
    events: args.events
      .filter((e) => e.visibility === 'public' && PUBLIC_EVENT_TYPES.has(e.type))
      .map((e) => ({
        seq: e.seq,
        type: e.type,
        entityType: e.entityType,
        entityId: e.entityId,
        createdAt: e.createdAt,
        payload: Object.fromEntries(
          Object.entries(e.payload)
            .filter(([k]) => PUBLIC_PAYLOAD_KEYS.has(k))
            .map(([k, v]) => [k, typeof v === 'string' ? scrubText(v) : v]),
        ),
      })),
  };
}

export type PublicReplay = ReturnType<typeof redactReplay>;
