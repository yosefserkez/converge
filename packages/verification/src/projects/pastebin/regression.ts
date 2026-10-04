import { type CheckResult, checkApplicability, type Digest, type Observation, PASTEBIN_CHECKS } from '@converge/domain';
import { z } from 'zod';
import { buildCheckResult } from '../../result.ts';
import type { CandidateRef } from '../../types.ts';

export const REGRESSION_CHECK_ID = 'paste.regression';

/** The part of a Vitest JSON report (the Jest-compatible format) that the harness reads. */
const VitestJsonReport = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      message: z.string().optional(),
      assertionResults: z.array(
        z.object({
          fullName: z.string().optional(),
          title: z.string(),
          status: z.string(),
          failureMessages: z.array(z.string()).optional(),
        }),
      ),
    }),
  ),
});

export interface RegressionMeta {
  candidate: CandidateRef;
  harnessDigest: Digest;
  startedAt: number;
  finishedAt: number;
}

const SKIPPED = new Set(['pending', 'skipped', 'todo', 'disabled']);

function relativeName(path: string): string {
  const at = path.search(/(?:^|\/)(worker|shared|frontend)\//);
  return at < 0 ? path : path.slice(at).replace(/^\//, '');
}

/**
 * Turns the project's Vitest JSON report into the paste.regression result.
 * One observation per test: assertions = tests that ran, failed = failed tests.
 * A test file that failed without a failed test (for example, it did not load)
 * adds one failed observation. Skipped tests are not assertions. Zero tests or
 * an unreadable report is an error, never a pass.
 *
 * The candidate container ran the suite, so the result is in-container
 * evidence: lower trust than the black-box checks.
 */
export function regressionResult(meta: RegressionMeta, vitestJsonReport: unknown): CheckResult {
  const def = PASTEBIN_CHECKS.find((c) => c.id === REGRESSION_CHECK_ID);
  if (!def) throw new Error(`catalog has no ${REGRESSION_CHECK_ID}`);
  const applicability = checkApplicability(def, new Set());
  const parsed = VitestJsonReport.safeParse(vitestJsonReport);
  const observations: Observation[] = [];
  let skipped = 0;
  if (parsed.success) {
    for (const file of parsed.data.testResults) {
      const fileName = relativeName(file.name);
      let failedInFile = 0;
      for (const test of file.assertionResults) {
        if (SKIPPED.has(test.status)) {
          skipped += 1;
          continue;
        }
        const passed = test.status === 'passed';
        if (!passed) failedInFile += 1;
        observations.push({
          label: `${fileName} > ${test.fullName ?? test.title}`,
          expected: 'passed',
          observed: passed ? 'passed' : { status: test.status, failureMessages: (test.failureMessages ?? []).slice(0, 3) },
          passed,
        });
      }
      if (file.status === 'failed' && failedInFile === 0) {
        observations.push({ label: `${fileName} (test file)`, expected: 'passed', observed: { status: file.status, message: file.message ?? '' }, passed: false });
      }
    }
  }
  const reason = `${applicability.reason}; in-container evidence: the candidate container ran the project Vitest suite (lower trust than black-box checks); ${skipped} skipped tests not counted`;
  return buildCheckResult({
    checkId: REGRESSION_CHECK_ID,
    candidate: meta.candidate,
    harnessDigest: meta.harnessDigest,
    applicable: applicability.applicable,
    applicabilityReason: reason,
    observations,
    ...(parsed.success ? {} : { error: `unreadable Vitest JSON report: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` }),
    startedAt: meta.startedAt,
    finishedAt: Math.max(meta.startedAt, meta.finishedAt),
  });
}
