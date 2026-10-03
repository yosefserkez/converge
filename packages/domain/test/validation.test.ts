import { describe, expect, it } from 'vitest';
import {
  ALL_CAPABILITIES,
  approvalEligibility,
  buildValidationManifest,
  type Capability,
  CHECKS,
  type EvidenceRef,
  type LatestCheckRun,
  validationDigestOf,
  type ValidationManifest,
} from '../src/index.ts';
import { dg, sha } from './fixtures.ts';

const harness = dg('7');
const evidence = (checkId: string): EvidenceRef => ({
  key: `private/prj/ses/checks/${checkId}.json`,
  sha256: dg('e'),
  bytes: 10,
  contentType: 'application/json',
  visibility: 'private',
});
const pass = (checkId: string): LatestCheckRun => ({
  checkId,
  status: 'passed',
  applicable: true,
  assertionCount: 4,
  failedCount: 0,
  evidence: evidence(checkId),
  harnessDigest: harness,
});

function build(capabilities: Capability[], runs: LatestCheckRun[]) {
  return buildValidationManifest({
    candidate: { id: 'cand-full', headSha: sha('9'), manifestDigest: dg('5') },
    policyDigest: dg('6'),
    harnessDigest: harness,
    checks: CHECKS,
    capabilities: new Set(capabilities),
    runs,
    fullGoalCapabilities: ALL_CAPABILITIES,
  });
}

const allRuns = () => CHECKS.map((c) => pass(c.id));

describe('buildValidationManifest', () => {
  it('produces a full-goal manifest when every applicable check passed with evidence', () => {
    const result = build([...ALL_CAPABILITIES], allRuns());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.fullGoalSatisfied).toBe(true);
    expect(result.manifest.requiredChecks.map((c) => c.checkId)).toEqual([...CHECKS.map((c) => c.id)].sort());
    expect(result.manifest.excludedChecks).toEqual([]);
  });

  it('excludes non-applicable checks with a reason and marks partial goals', () => {
    const runs = allRuns().filter((r) => r.checkId !== 'cache.reuse' && r.checkId !== 'checkout.summary');
    const result = build(['membership-pricing'], runs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.fullGoalSatisfied).toBe(false);
    expect(result.manifest.excludedChecks).toEqual([
      { checkId: 'cache.reuse', reason: 'capability quote-cache is not in this candidate' },
      { checkId: 'checkout.summary', reason: 'capability checkout-summary is not in this candidate' },
    ]);
  });

  const blockerCases: Array<[string, (runs: LatestCheckRun[]) => LatestCheckRun[], string]> = [
    ['missing', (rs) => rs.filter((r) => r.checkId !== 'cache.reuse'), 'CHECK_MISSING'],
    ['pending', (rs) => rs.map((r) => (r.checkId === 'cache.reuse' ? { ...r, status: 'pending' } : r)), 'CHECK_PENDING'],
    ['error', (rs) => rs.map((r) => (r.checkId === 'cache.reuse' ? { ...r, status: 'error' } : r)), 'CHECK_ERROR'],
    ['failed', (rs) => rs.map((r) => (r.checkId === 'cache.reuse' ? { ...r, status: 'failed', failedCount: 1 } : r)), 'CHECK_FAILED'],
    ['zero assertions', (rs) => rs.map((r) => (r.checkId === 'cache.reuse' ? { ...r, assertionCount: 0 } : r)), 'ZERO_ASSERTIONS'],
    ['skipped while applicable', (rs) => rs.map((r) => (r.checkId === 'cache.reuse' ? { ...r, status: 'skipped' } : r)), 'CHECK_SKIPPED'],
    ['harness mismatch', (rs) => rs.map((r) => (r.checkId === 'cache.reuse' ? { ...r, harnessDigest: dg('8') } : r)), 'HARNESS_MISMATCH'],
    [
      'evidence missing',
      (rs) => rs.map((r) => (r.checkId === 'cache.reuse' ? { ...r, evidence: undefined } : r)),
      'EVIDENCE_MISSING',
    ],
    [
      'applicability mismatch',
      (rs) => rs.map((r) => (r.checkId === 'cache.reuse' ? { ...r, applicable: false } : r)),
      'APPLICABILITY_MISMATCH',
    ],
    ['duplicate run', (rs) => [...rs, pass('cache.reuse')], 'DUPLICATE_RUN'],
    ['unknown check', (rs) => [...rs, pass('not.a.check')], 'UNKNOWN_CHECK'],
  ];

  it.each(blockerCases)('blocks on %s', (_name, mutate, code) => {
    const result = build([...ALL_CAPABILITIES], mutate(allRuns()));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blockers.map((b) => b.code)).toEqual([code]);
  });
});

describe('approvalEligibility', () => {
  async function fixture(capabilities: Capability[] = [...ALL_CAPABILITIES]) {
    const runs = allRuns().filter((r) => capabilities.length === 3 || (r.checkId !== 'cache.reuse' && r.checkId !== 'checkout.summary'));
    const result = build(capabilities, runs);
    if (!result.ok) throw new Error('fixture must build');
    const manifest: ValidationManifest = result.manifest;
    const validationDigest = await validationDigestOf(manifest);
    const base = {
      candidateState: 'passed' as const,
      manifest,
      validationDigest,
      reviewed: { headSha: manifest.headSha, validationDigest, expectedMainSha: sha('a') },
      observedMainSha: sha('a'),
      evidenceVerified: true,
    };
    return base;
  }

  it('allows a passed, full-goal, freshly reviewed candidate', async () => {
    expect(approvalEligibility(await fixture())).toEqual([]);
  });

  it('refuses a partial-goal candidate', async () => {
    const codes = approvalEligibility(await fixture(['membership-pricing'])).map((b) => b.code);
    expect(codes).toEqual(['NOT_PROMOTABLE']);
  });

  it('refuses a candidate that is not passed or has no manifest', async () => {
    const f = await fixture();
    expect(approvalEligibility({ ...f, candidateState: 'failed' }).map((b) => b.code)).toEqual(['NOT_PROMOTABLE']);
    expect(approvalEligibility({ ...f, manifest: null, validationDigest: null }).map((b) => b.code)).toEqual(['NOT_PROMOTABLE']);
  });

  it('flags stale reviews, a moved main, and unverified evidence', async () => {
    const f = await fixture();
    expect(approvalEligibility({ ...f, reviewed: { ...f.reviewed, validationDigest: dg('0') } }).map((b) => b.code)).toEqual([
      'STALE_APPROVAL',
    ]);
    expect(approvalEligibility({ ...f, reviewed: { ...f.reviewed, headSha: sha('1') } }).map((b) => b.code)).toEqual([
      'STALE_APPROVAL',
    ]);
    expect(approvalEligibility({ ...f, observedMainSha: sha('b') }).map((b) => b.code)).toEqual(['STALE_MAIN']);
    expect(approvalEligibility({ ...f, evidenceVerified: false }).map((b) => b.code)).toEqual(['EVIDENCE_MISSING']);
  });
});
