import { digestOf } from './canonical.ts';
import { checkApplicability, type CheckDefinition } from './catalog.ts';
import { DomainError } from './errors.ts';
import { compareStrings } from './order.ts';
import type { Capability, CandidateState, CheckStatus, EvidenceRef } from './schemas.ts';
import { ValidationManifest } from './schemas.ts';

// Validation manifest and approval gates (brief §9 "Human approval", §11).

export type ValidationBlockerCode =
  | 'CHECK_MISSING'
  | 'CHECK_PENDING'
  | 'CHECK_FAILED'
  | 'CHECK_ERROR'
  | 'CHECK_SKIPPED'
  | 'ZERO_ASSERTIONS'
  | 'EVIDENCE_MISSING'
  | 'HARNESS_MISMATCH'
  | 'APPLICABILITY_MISMATCH'
  | 'DUPLICATE_RUN'
  | 'UNKNOWN_CHECK';

export interface ValidationBlocker {
  checkId?: string;
  code: ValidationBlockerCode;
  reason: string;
}

export interface LatestCheckRun {
  checkId: string;
  status: CheckStatus | 'pending';
  applicable: boolean;
  assertionCount: number;
  failedCount: number;
  evidence?: EvidenceRef;
  harnessDigest: string;
}

export type ManifestResult = { ok: true; manifest: ValidationManifest } | { ok: false; blockers: ValidationBlocker[] };

function runBlocker(run: LatestCheckRun, harnessDigest: string): ValidationBlocker | undefined {
  const checkId = run.checkId;
  if (!run.applicable) return { checkId, code: 'APPLICABILITY_MISMATCH', reason: 'run says not applicable, but policy says it applies' };
  switch (run.status) {
    case 'pending':
      return { checkId, code: 'CHECK_PENDING', reason: 'check has not finished' };
    case 'error':
      return { checkId, code: 'CHECK_ERROR', reason: 'check errored; an error is not a result' };
    case 'skipped':
      return { checkId, code: 'CHECK_SKIPPED', reason: 'check was skipped but applies; a skip is not a pass' };
    case 'failed':
      return { checkId, code: 'CHECK_FAILED', reason: `${run.failedCount} of ${run.assertionCount} assertions failed` };
    case 'passed':
      break;
  }
  if (run.failedCount > 0) return { checkId, code: 'CHECK_FAILED', reason: `passed status with ${run.failedCount} failed assertions` };
  if (run.assertionCount <= 0) return { checkId, code: 'ZERO_ASSERTIONS', reason: 'passed with zero assertions' };
  if (run.harnessDigest !== harnessDigest) return { checkId, code: 'HARNESS_MISMATCH', reason: 'run used a different harness' };
  if (!run.evidence) return { checkId, code: 'EVIDENCE_MISSING', reason: 'no stored evidence for this run' };
  return undefined;
}

export function buildValidationManifest(input: {
  candidate: { id: string; headSha: string; manifestDigest: string };
  policyDigest: string;
  harnessDigest: string;
  checks: readonly CheckDefinition[];
  capabilities: ReadonlySet<Capability>;
  runs: readonly LatestCheckRun[];
  fullGoalCapabilities: readonly Capability[];
}): ManifestResult {
  const blockers: ValidationBlocker[] = [];
  const known = new Set(input.checks.map((c) => c.id));
  const runs = new Map<string, LatestCheckRun>();
  for (const run of input.runs) {
    if (!known.has(run.checkId)) {
      blockers.push({ checkId: run.checkId, code: 'UNKNOWN_CHECK', reason: 'run for a check outside the frozen policy' });
    } else if (runs.has(run.checkId)) {
      blockers.push({ checkId: run.checkId, code: 'DUPLICATE_RUN', reason: 'expected only the latest run per check' });
    } else {
      runs.set(run.checkId, run);
    }
  }

  const requiredChecks: ValidationManifest['requiredChecks'] = [];
  const excludedChecks: ValidationManifest['excludedChecks'] = [];
  for (const check of [...input.checks].sort((a, b) => compareStrings(a.id, b.id))) {
    const applicability = checkApplicability(check, input.capabilities);
    if (!applicability.applicable) {
      excludedChecks.push({ checkId: check.id, reason: applicability.reason });
      continue;
    }
    const run = runs.get(check.id);
    if (!run) {
      blockers.push({ checkId: check.id, code: 'CHECK_MISSING', reason: `no run; required because ${applicability.reason}` });
      continue;
    }
    const blocker = runBlocker(run, input.harnessDigest);
    if (blocker) blockers.push(blocker);
    else requiredChecks.push({ checkId: check.id, result: run.evidence! });
  }
  if (blockers.length > 0) return { ok: false, blockers };

  const parsed = ValidationManifest.safeParse({
    schemaVersion: 1,
    candidateId: input.candidate.id,
    headSha: input.candidate.headSha,
    candidateManifestDigest: input.candidate.manifestDigest,
    policyDigest: input.policyDigest,
    harnessDigest: input.harnessDigest,
    requiredChecks,
    excludedChecks,
    fullGoalSatisfied: input.fullGoalCapabilities.every((c) => input.capabilities.has(c)),
  });
  if (!parsed.success) {
    throw new DomainError('INVALID_INPUT', 'invalid validation manifest input', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return { ok: true, manifest: parsed.data };
}

export function validationDigestOf(manifest: ValidationManifest): Promise<string> {
  return digestOf(manifest);
}

export type ApprovalBlockerCode = 'NOT_PROMOTABLE' | 'STALE_APPROVAL' | 'STALE_MAIN' | 'EVIDENCE_MISSING';

export interface ApprovalBlocker {
  code: ApprovalBlockerCode;
  reason: string;
}

/** Empty list means the reviewed candidate may be approved now. */
export function approvalEligibility(input: {
  candidateState: CandidateState;
  manifest: ValidationManifest | null;
  validationDigest: string | null;
  reviewed: { headSha: string; validationDigest: string; expectedMainSha: string };
  observedMainSha: string;
  evidenceVerified: boolean;
}): ApprovalBlocker[] {
  const blockers: ApprovalBlocker[] = [];
  if (input.candidateState !== 'passed') {
    blockers.push({ code: 'NOT_PROMOTABLE', reason: `candidate is ${input.candidateState}, not passed` });
  }
  const { manifest } = input;
  if (!manifest || input.validationDigest === null) {
    blockers.push({ code: 'NOT_PROMOTABLE', reason: 'candidate has no frozen validation manifest' });
  } else {
    if (!manifest.fullGoalSatisfied) {
      blockers.push({ code: 'NOT_PROMOTABLE', reason: 'candidate does not satisfy every goal capability' });
    }
    if (input.reviewed.headSha !== manifest.headSha) {
      blockers.push({ code: 'STALE_APPROVAL', reason: 'reviewed head differs from the validated head' });
    }
    if (input.reviewed.validationDigest !== input.validationDigest) {
      blockers.push({ code: 'STALE_APPROVAL', reason: 'reviewed validation digest differs from the current one' });
    }
  }
  if (input.observedMainSha !== input.reviewed.expectedMainSha) {
    blockers.push({ code: 'STALE_MAIN', reason: 'canonical main moved since review' });
  }
  if (!input.evidenceVerified) {
    blockers.push({ code: 'EVIDENCE_MISSING', reason: 'evidence objects are missing or do not match their digests' });
  }
  return blockers;
}
