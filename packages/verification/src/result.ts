import { CheckResult, type CheckStatus, type Observation } from '@converge/domain';
import { boundString } from './bounded.ts';

export interface ResultInput {
  checkId: string;
  candidate: { candidateId: string; headSha: string; manifestDigest: string };
  harnessDigest: string;
  applicable: boolean;
  applicabilityReason: string;
  observations: readonly Observation[];
  /** Set when the check threw (transport failure, timeout, harness bug). */
  error?: string;
  startedAt: number;
  finishedAt: number;
}

/**
 * Derives status from the observations. Rules:
 * - not applicable: 'skipped', zero assertions, no observations;
 * - thrown error: 'error', never 'passed';
 * - zero assertions: 'error', never 'passed';
 * - any failed assertion: 'failed'.
 */
export function deriveStatus(applicable: boolean, assertionCount: number, failedCount: number, error: string | undefined): CheckStatus {
  if (!applicable) return 'skipped';
  if (error !== undefined) return 'error';
  if (assertionCount === 0) return 'error';
  return failedCount > 0 ? 'failed' : 'passed';
}

export function buildCheckResult(input: ResultInput): CheckResult {
  const observations: Observation[] = input.applicable ? [...input.observations] : [];
  if (input.applicable && input.error !== undefined) {
    observations.push({ label: 'harness error', expected: 'check completes without error', observed: boundString(input.error), passed: false });
  }
  if (input.applicable && input.error === undefined && observations.length === 0) {
    observations.push({ label: 'assertion count', expected: 'at least 1 assertion', observed: 0, passed: false });
  }
  const assertionCount = observations.length;
  const failedCount = observations.filter((o) => !o.passed).length;
  return CheckResult.parse({
    schemaVersion: 1,
    checkId: input.checkId,
    candidateId: input.candidate.candidateId,
    candidateHeadSha: input.candidate.headSha,
    candidateManifestDigest: input.candidate.manifestDigest,
    harnessDigest: input.harnessDigest,
    status: deriveStatus(input.applicable, input.observations.length, failedCount, input.error),
    applicable: input.applicable,
    applicabilityReason: input.applicabilityReason,
    assertionCount,
    failedCount,
    observations,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  });
}

/** Lists ways a result breaks harness invariants. An empty list means it is consistent. */
export function resultInvariantViolations(result: CheckResult): string[] {
  const problems: string[] = [];
  const failed = result.observations.filter((o) => !o.passed).length;
  if (result.assertionCount !== result.observations.length) problems.push('assertionCount differs from observation count');
  if (result.failedCount !== failed) problems.push('failedCount differs from failed observations');
  if (!result.applicable && result.status !== 'skipped') problems.push('non-applicable check is not skipped');
  if (result.applicable && result.status === 'skipped') problems.push('applicable check is skipped');
  if (result.status === 'skipped' && result.assertionCount !== 0) problems.push('skipped check has assertions');
  if (result.status === 'passed' && result.assertionCount === 0) problems.push('passed check has zero assertions');
  if (result.status === 'passed' && result.failedCount > 0) problems.push('passed check has failed assertions');
  if (result.finishedAt < result.startedAt) problems.push('finishedAt precedes startedAt');
  return problems;
}

/** True only for an applicable, consistent, passed result with at least one assertion. */
export function isVerifiedPass(result: CheckResult): boolean {
  return result.status === 'passed' && result.applicable && result.assertionCount > 0 && resultInvariantViolations(result).length === 0;
}
