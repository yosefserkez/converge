import { env, evictDurableObject } from 'cloudflare:test';
import { CHECKS, type Capability, type CandidatePlan, type ValidationManifest, checkApplicability } from '@converge/domain';
import { describe, expect, it } from 'vitest';
import { evidencePrefix, verifyEvidence, writeEvidence } from '../worker/evidence.ts';
import {
  type CandidateView,
  type Coordinator,
  type Decide,
  type ErrorBody,
  SLUG,
  agentJobFor,
  candidate,
  checkResult,
  command,
  errorOf,
  freshCoordinator,
  integrate,
  jobs,
  lease,
  ok,
  pump,
  runAgent,
  sealAgent,
  snapshot,
  sql,
  startAgent,
  startedSession,
  verify,
} from './helpers.ts';

const caps = (c: CandidateView) => new Set<Capability>(c.capabilities);

/** The A+B interaction: any unrepaired candidate with pricing and caching fails customer isolation. */
const isolationFails: Decide = (c, checkId, applicable) => {
  if (!applicable) return 'skipped';
  const s = caps(c);
  const unrepaired = c.anchorCandidateId === null;
  return checkId === 'pricing.isolation' && s.has('membership-pricing') && s.has('quote-cache') && unrepaired ? 'failed' : 'passed';
};

async function candidatesByLabel(stub: Coordinator, sessionId: string) {
  const snap = await snapshot(stub, sessionId);
  return new Map(snap.candidates.map((c) => [c.label, c]));
}

describe('deterministic orchestration with simulated effects', () => {
  it('runs seed to promotion: interaction, repair, final candidate, approval, promotion', async () => {
    const stub = freshCoordinator('scenario');
    const { seeded, sessionId } = await startedSession(stub);

    let snap = await snapshot(stub, sessionId);
    expect(snap.session.status).toBe('running');
    expect(snap.jobs.filter((j) => j.kind === 'agent')).toHaveLength(3);
    expect(snap.candidates.map((c) => [c.label, c.state])).toEqual([['Baseline', 'planned']]);
    const proposalOf = (role: string) => snap.proposals.find((p) => p.role === role)!;
    const pricingId = proposalOf('pricing').id;
    const cachingId = proposalOf('caching').id;
    const checkoutId = proposalOf('checkout').id;

    // ---- agents declare intents ----
    const pricing = await startAgent(stub, 'pricing');
    const caching = await startAgent(stub, 'caching');
    snap = await snapshot(stub, sessionId);
    const predicted = snap.interactions.filter((i) => i.kind === 'assumption' && i.contractKey === 'unit-price.dimensions');
    expect(predicted).toHaveLength(1);
    expect(predicted[0]).toMatchObject({ state: 'predicted', leftProposalId: pricingId, rightProposalId: cachingId });
    const interactionId = predicted[0]!.id;
    // Each side gets a targeted inbox message about the other change.
    const inbox = await stub.wfReadInbox(caching.lease.jobId, caching.lease.fence, 0);
    expect(inbox.map((m) => m.kind)).toContain('interaction');
    const checkout = await startAgent(stub, 'checkout');
    // The checkout change touches no contract the others change, so its inbox stays empty.
    expect(await stub.wfReadInbox(checkout.lease.jobId, checkout.lease.fence, 0)).toEqual([]);
    const checkoutSnap = await snapshot(stub, sessionId);
    expect(checkoutSnap.interactions.some((i) => i.state === 'predicted' && [i.leftProposalId, i.rightProposalId].includes(checkoutId))).toBe(false);
    expect(snap.proposals.every((p) => p.status === 'working' || p.role === 'checkout')).toBe(true);

    // ---- agents seal ----
    const pricingRev = await sealAgent(stub, pricing.lease, pricing.input);
    const cachingRev = await sealAgent(stub, caching.lease, caching.input);
    expect((await snapshot(stub, sessionId)).session.status).toBe('running');
    const checkoutRev = await sealAgent(stub, checkout.lease, checkout.input);

    snap = await snapshot(stub, sessionId);
    expect(snap.session.status).toBe('validating');
    let byLabel = await candidatesByLabel(stub, sessionId);
    const pairLabel = 'Member pricing + Unit-price cache';
    const fullLabel = 'Member pricing + Unit-price cache + Checkout summary';
    expect([...byLabel.keys()].sort()).toEqual(['Baseline', 'Member pricing', 'Unit-price cache', 'Checkout summary', pairLabel, fullLabel].sort());
    expect(byLabel.get('Member pricing')!.members).toEqual([pricingRev.revisionId]);
    expect(byLabel.get('Unit-price cache')!.members).toEqual([cachingRev.revisionId]);
    expect(byLabel.get('Checkout summary')!.members).toEqual([checkoutRev.revisionId]);
    expect(byLabel.get(pairLabel)!.members).toEqual([pricingRev.revisionId, cachingRev.revisionId]);
    expect(byLabel.get(fullLabel)!.members).toEqual([pricingRev.revisionId, cachingRev.revisionId, checkoutRev.revisionId]);
    expect([...byLabel.values()].every((c) => c.state === 'planned')).toBe(true);
    expect(await jobs(stub, "kind = 'integrate' AND status = 'queued'")).toHaveLength(6);

    // ---- restart mid-scenario: state, jobs and evidence references persist ----
    const beforeRestart = await stub.getSessionSnapshotJson(sessionId);
    const jobsBefore = await jobs(stub);
    const evidenceBefore = await sql<{ r2_key: string; sha256: string }>(stub, 'SELECT r2_key, sha256 FROM evidence ORDER BY r2_key');
    await evictDurableObject(stub);
    const restarted = env.PROJECTS.get(stub.id);
    expect(await restarted.getSessionSnapshotJson(sessionId)).toBe(beforeRestart);
    expect(await jobs(restarted)).toEqual(jobsBefore);
    const evidenceAfter = await sql<{ r2_key: string; sha256: string }>(restarted, 'SELECT r2_key, sha256 FROM evidence ORDER BY r2_key');
    expect(evidenceAfter).toEqual(evidenceBefore);
    expect(evidenceAfter.map((e) => e.r2_key)).toContain(pricingRev.diff.key);
    for (const e of evidenceAfter) await expect(verifyEvidence(env.EVIDENCE, e.r2_key, e.sha256)).resolves.toBeDefined();

    // ---- integrate and verify the initial candidates ----
    expect(await pump(restarted, isolationFails)).toBe(12);
    byLabel = await candidatesByLabel(restarted, sessionId);
    for (const label of ['Baseline', 'Member pricing', 'Unit-price cache', 'Checkout summary']) {
      expect(byLabel.get(label)!.state, label).toBe('passed');
    }
    const pair = byLabel.get(pairLabel)!;
    const full = byLabel.get(fullLabel)!;
    expect(pair.state).toBe('failed');
    expect(full.state).toBe('failed');
    expect(pair.promotable || full.promotable).toBe(false);
    const pairView = await candidate(restarted, pair.id);
    expect(pairView.checks.find((c) => c.checkId === 'pricing.isolation')).toMatchObject({ status: 'failed', applicable: true });
    expect(pairView.checks.find((c) => c.checkId === 'checkout.summary')).toMatchObject({ status: 'skipped', applicable: false });
    expect(pairView.checks.every((c) => c.evidenceId !== null)).toBe(true);

    snap = await snapshot(restarted, sessionId);
    const confirmed = snap.interactions.find((i) => i.id === interactionId)!;
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.failedCandidateId).toBe(pair.id);
    expect(confirmed.failedCheck?.checkId).toBe('pricing.isolation');

    // ---- repair is assigned against the exact failed pair ----
    expect(snap.session.status).toBe('repairing');
    const repair = snap.proposals.find((p) => p.kind === 'repair')!;
    expect(repair.baseCandidateId).toBe(pair.id);
    const { input: repairInput } = await agentJobFor(restarted, 'repair');
    expect(repairInput.baseSha).toBe(pair.headSha);
    expect(repairInput.baseRepo).toBe(pair.repoName);
    const [repairJob] = await jobs(restarted, "kind = 'agent' AND entity_id = ?", repair.id);
    const counterexample = (JSON.parse(repairJob!.input_json) as { counterexample: { failedChecks: Array<{ checkId: string; observations: Array<{ passed: boolean }> }> } })
      .counterexample;
    expect(counterexample.failedChecks.map((f) => f.checkId)).toEqual(['pricing.isolation']);
    expect(counterexample.failedChecks[0]!.observations.length).toBeGreaterThan(0);
    expect(counterexample.failedChecks[0]!.observations.every((o) => !o.passed)).toBe(true);

    // ---- the repair seals; the final candidate is anchored on the pair ----
    const repairRev = await runAgent(restarted, 'repair');
    snap = await snapshot(restarted, sessionId);
    expect(snap.session.status).toBe('validating');
    const finalRow = snap.candidates.find((c) => c.anchorCandidateId === pair.id)!;
    expect(finalRow).toBeDefined();
    expect(finalRow.label).toBe('Full goal + Repair 1');
    expect(finalRow.members).toEqual([pricingRev.revisionId, cachingRev.revisionId, checkoutRev.revisionId, repairRev.revisionId]);
    const [planRow] = await sql<{ plan_json: string }>(restarted, 'SELECT plan_json FROM candidate WHERE id = ?', finalRow.id);
    const plan = JSON.parse(planRow!.plan_json) as CandidatePlan;
    expect(plan.anchor).toEqual({ candidateId: pair.id, headSha: pair.headSha, includedRevisionIds: [pricingRev.revisionId, cachingRev.revisionId] });
    const repairDeps = snap.proposals.find((p) => p.id === repair.id)!.revisions[0]!.dependencies;
    expect([...repairDeps].sort()).toEqual([pricingRev.revisionId, cachingRev.revisionId].sort());
    expect(plan.members.find((m) => m.revisionId === repairRev.revisionId)!.baseSha).toBe(pair.headSha);

    // Assembly starts from the pair head and merges only the members outside the anchor.
    const [finalIntegrate] = await jobs(restarted, "kind = 'integrate' AND entity_id = ?", finalRow.id);
    const assembled = await integrate(restarted, finalIntegrate!.id);
    expect(assembled.plan.start).toEqual({ repo: pair.repoName, sha: pair.headSha });
    expect(assembled.plan.merges.map((m) => m.label)).toEqual([checkoutRev.revisionId, repairRev.revisionId]);

    // ---- every check passes on the final candidate ----
    expect(await pump(restarted, isolationFails)).toBe(1);
    const finalView = await candidate(restarted, finalRow.id);
    expect(finalView).toMatchObject({ state: 'passed', promotable: true, fullGoal: true, headSha: assembled.headSha });
    expect(finalView.validationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const [validationEvidence] = await sql<{ r2_key: string; sha256: string }>(
      restarted,
      "SELECT r2_key, sha256 FROM evidence WHERE kind = 'validation' AND sha256 = ?",
      finalView.validationDigest,
    );
    const manifest = await verifyEvidence<ValidationManifest>(env.EVIDENCE, validationEvidence!.r2_key, validationEvidence!.sha256);
    expect(manifest).toMatchObject({ candidateId: finalRow.id, headSha: assembled.headSha, fullGoalSatisfied: true, excludedChecks: [] });
    expect(manifest.requiredChecks.map((c) => c.checkId)).toEqual(CHECKS.map((c) => c.id).sort());

    snap = await snapshot(restarted, sessionId);
    const resolved = snap.interactions.find((i) => i.id === interactionId)!;
    expect(resolved.state).toBe('resolved');
    expect(resolved.resolvedCandidateId).toBe(finalRow.id);
    expect(snap.session.status).toBe('ready');
    // The failed pair stays failed: a repair never turns it green.
    expect(snap.candidates.find((c) => c.id === pair.id)!.state).toBe('failed');

    // ---- approval ----
    const approval = { candidateId: finalRow.id, expectedMainSha: seeded.mainSha, validationDigest: finalView.validationDigest, decision: 'approve' };
    const wrong = await command<ErrorBody>(restarted, 'approve', { ...approval, headSha: pair.headSha });
    expect(wrong.status).toBe(409);
    expect(['STALE_APPROVAL', 'NOT_PROMOTABLE']).toContain(wrong.body.error.code);
    expect(await sql(restarted, 'SELECT * FROM approval')).toHaveLength(0);

    const approved = await ok<{ approvalId: string; decision: string }>(restarted, 'approve', { ...approval, headSha: assembled.headSha });
    expect(approved.decision).toBe('approve');
    const [approvalRow] = await sql<{ head_sha: string; validation_digest: string; expected_main_sha: string }>(
      restarted,
      'SELECT head_sha, validation_digest, expected_main_sha FROM approval WHERE id = ?',
      approved.approvalId,
    );
    expect(approvalRow).toEqual({ head_sha: assembled.headSha, validation_digest: finalView.validationDigest, expected_main_sha: seeded.mainSha });

    // ---- promotion ----
    const promoted = await ok<{ promotionId: string; jobId: string; state: string }>(restarted, 'promote', { approvalId: approved.approvalId });
    expect(promoted.state).toBe('pending');
    const [promoteJob] = await jobs(restarted, "kind = 'promote'");
    expect(promoteJob!.id).toBe(promoted.jobId);
    const promoteLease = await lease(restarted, promoted.jobId);
    const receipt = await writeEvidence(env.EVIDENCE, {
      prefix: evidencePrefix(SLUG, sessionId, 'receipts'),
      body: { promotionId: promoted.promotionId, candidateSha: assembled.headSha, expectedMainSha: seeded.mainSha },
      visibility: 'private',
    });
    await restarted.wfPromotionResult(promoteLease.jobId, promoteLease.fence, {
      state: 'succeeded',
      observedRemoteSha: assembled.headSha,
      reconciled: false,
      receipt,
    });
    snap = await snapshot(restarted, sessionId);
    expect(snap.session.status).toBe('promoted');
    expect(snap.promotions).toHaveLength(1);
    expect(snap.promotions[0]).toMatchObject({ state: 'succeeded', target_sha: assembled.headSha, observed_remote_sha: assembled.headSha });
    expect((await restarted.getProjectSummary()).observedMainSha).toBe(assembled.headSha);
  });

  it('a zero-assertion pass or a skipped applicable check blocks promotability', async () => {
    const stub = freshCoordinator('blockers');
    const { sessionId } = await startedSession(stub);
    for (const role of ['pricing', 'caching', 'checkout'] as const) await runAgent(stub, role);
    // Integrate everything, then verify every candidate except the full one with honest passes.
    const fullLabel = 'Member pricing + Unit-price cache + Checkout summary';
    for (const job of await jobs(stub, "kind = 'integrate' AND status = 'queued'")) await integrate(stub, job.id);
    const byLabel = await candidatesByLabel(stub, sessionId);
    const full = byLabel.get(fullLabel)!;
    for (const job of await jobs(stub, "kind = 'verify' AND status = 'queued' AND entity_id <> ?", full.id)) await verify(stub, job.id);

    const [fullVerify] = await jobs(stub, "kind = 'verify' AND entity_id = ?", full.id);
    const l = await lease(stub, fullVerify!.id);
    const input = await stub.wfVerifyInput(l.jobId, l.fence);
    const meta = { candidateId: input.candidateId, headSha: input.headSha, manifestDigest: input.manifestDigest, harnessDigest: input.harnessDigest };
    const capSet = new Set(input.capabilities as Capability[]);
    const record = async (checkId: string, shape: 'honest' | 'zero-assertions' | 'skipped') => {
      const def = CHECKS.find((c) => c.id === checkId)!;
      const a = checkApplicability(def, capSet);
      let result = checkResult(meta, checkId, a.applicable, a.reason, 'passed');
      if (shape === 'zero-assertions') result = { ...result, observations: [], assertionCount: 0, failedCount: 0 };
      if (shape === 'skipped') result = checkResult(meta, checkId, false, 'verifier skipped it', 'skipped');
      const ref = await writeEvidence(env.EVIDENCE, { prefix: evidencePrefix(SLUG, sessionId, 'checks'), body: result, visibility: 'private' });
      return stub.wfRecordCheck(l.jobId, l.fence, result, ref);
    };
    expect(await errorOf(record('pricing.isolation', 'zero-assertions'))).toMatch(/^INVALID_INPUT:/);
    expect(await errorOf(record('checkout.summary', 'skipped'))).toMatch(/^INVALID_INPUT:/);
    for (const c of CHECKS) {
      if (c.id !== 'pricing.isolation' && c.id !== 'checkout.summary') await record(c.id, 'honest');
    }
    await stub.wfVerified(l.jobId, l.fence);

    const view = await candidate(stub, full.id);
    expect(view.state).toBe('failed');
    expect(view.promotable).toBe(false);
    expect(view.validationDigest).toBeNull();
    expect(view.checks.map((c) => c.checkId).sort()).toEqual(['cache.reuse', 'quote.contract', 'quote.quantity', 'pricing.tiers'].sort());
    const snap = await snapshot(stub, sessionId);
    expect(snap.session.status).not.toBe('ready');
    expect(snap.candidates.some((c) => c.promotable)).toBe(false);

    // An operator cannot approve it either.
    const approve = await command<ErrorBody>(stub, 'approve', {
      candidateId: full.id,
      headSha: view.headSha,
      expectedMainSha: view.expectedMainSha,
      validationDigest: `sha256:${'0'.repeat(64)}`,
      decision: 'approve',
    });
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe('NOT_PROMOTABLE');
  });
});
