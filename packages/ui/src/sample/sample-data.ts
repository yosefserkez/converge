// SAMPLE DATA for local visual checks (`?sample=1`). It is not a recording.
// The UI labels every screen that uses it as sample data.
// Shapes are the real DTO types, so the type check catches drift.
import type { ChangeIntent, CheckResult, Json, Observation } from '@converge/domain';
import cachingManifest from '../../../../fixtures/deterministic/caching/manifest.json';
import checkoutManifest from '../../../../fixtures/deterministic/checkout/manifest.json';
import pricingManifest from '../../../../fixtures/deterministic/pricing/manifest.json';
import repairManifest from '../../../../fixtures/deterministic/repair/manifest.json';
import type { CandidateDetail, EventsPage, EvidenceDto, ProposalDetail, PublicReplay, SessionSnapshot } from '../dto.ts';

type Snap = SessionSnapshot;
type Candidate = Snap['candidates'][number];
type Proposal = Snap['proposals'][number];

export const SAMPLE_VARIANTS = ['ready', 'running', 'cancelling', 'failed-agent', 'stale', 'approved', 'promoted', 'fixture'] as const;
export type SampleVariant = (typeof SAMPLE_VARIANTS)[number];

/** Deterministic 40-hex fake Git object ID. */
function sha(seed: string): string {
  let h1 = 0x811c9dc5;
  let out = '';
  for (let round = 0; out.length < 40; round++) {
    for (const ch of `${seed}:${round}`) h1 = Math.imul(h1 ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    out += h1.toString(16).padStart(8, '0');
  }
  return out.slice(0, 40);
}
const digest = (seed: string) => `sha256:${sha(seed)}${sha(`${seed}#`)}`.slice(0, 71);

// Times are relative to page load so open spans and countdowns look current.
let T0 = Date.now() - 10 * 60_000;
const s = (sec: number) => T0 + Math.round(sec * 1000);

const BASELINE = sha('baseline');
const SESSION_ID = 'ses_sample0000000000000000000';

const intentOf = (m: { intent: unknown }) => m.intent as ChangeIntent;

function proposal(p: {
  id: string;
  title: string;
  role: Proposal['role'];
  kind?: Proposal['kind'];
  intent: ChangeIntent;
  summary: string;
  editablePaths: string[];
  capabilityIds: Proposal['capabilityIds'];
  rev: string;
  revAt: number;
  jobId: string;
  progress: string;
  progressAt: number;
  baseCandidateId?: string;
  intentVersion?: number;
}): Proposal {
  return {
    id: p.id,
    title: p.title,
    kind: p.kind ?? 'feature',
    role: p.role,
    status: 'sealed',
    objective: p.intent.objective,
    editablePaths: p.editablePaths,
    capabilityIds: p.capabilityIds,
    baseCandidateId: p.baseCandidateId ?? null,
    repoName: `prop-${p.role}`,
    intent: p.intent,
    intentVersion: p.intentVersion ?? 1,
    summary: p.summary,
    progress: { message: p.progress, at: p.progressAt },
    job: { id: p.jobId, status: 'succeeded', attemptNo: 1, errorCode: null },
    revisions: [
      {
        id: p.rev,
        revisionNo: 1,
        repoName: `prop-${p.role}`,
        baseSha: p.baseCandidateId ? sha('cand-full') : BASELINE,
        headSha: sha(p.rev),
        treeSha: sha(`${p.rev}-tree`),
        intentDigest: digest(`${p.id}-intent`),
        diffEvidenceId: `ev_diff_${p.role}`,
        dependencies: p.baseCandidateId ? ['rev_pricing', 'rev_caching', 'rev_checkout'] : [],
        createdAt: p.revAt,
      },
    ],
  };
}

const PROPOSALS = (): Proposal[] => [
  proposal({
    id: 'prop_pricing',
    title: 'Member pricing',
    role: 'pricing',
    intent: intentOf(pricingManifest),
    summary: pricingManifest.summary,
    editablePaths: ['src/pricing/compute-unit-price.ts', 'tests/pricing.test.ts'],
    capabilityIds: ['membership-pricing'],
    rev: 'rev_pricing',
    revAt: s(71),
    jobId: 'job_pricing',
    progress: 'Local tests pass: members pay 8000 for the backpack, regular customers pay 10000. Requested finish.',
    progressAt: s(69),
    intentVersion: 2,
  }),
  proposal({
    id: 'prop_caching',
    title: 'Unit-price cache',
    role: 'caching',
    intent: intentOf(cachingManifest),
    summary: cachingManifest.summary,
    editablePaths: ['src/pricing/quote-cache.ts', 'tests/quote-cache.test.ts'],
    capabilityIds: ['quote-cache'],
    rev: 'rev_caching',
    revAt: s(58),
    jobId: 'job_caching',
    progress: 'Cache keyed by productId. Repeated quotes reuse the unit price; quantity stays outside the cache.',
    progressAt: s(56),
  }),
  proposal({
    id: 'prop_checkout',
    title: 'Checkout summary',
    role: 'checkout',
    intent: intentOf(checkoutManifest),
    summary: checkoutManifest.summary,
    editablePaths: ['src/ui/CheckoutSummary.tsx', 'src/ui/checkout.css', 'tests/checkout.test.tsx'],
    capabilityIds: ['checkout-summary'],
    rev: 'rev_checkout',
    revAt: s(83),
    jobId: 'job_checkout',
    progress: 'Summary shows list price, member savings, unit price, quantity, and total in a labelled list.',
    progressAt: s(81),
  }),
  proposal({
    id: 'prop_repair1',
    title: 'Repair 1',
    role: 'repair',
    kind: 'repair',
    intent: intentOf(repairManifest),
    summary: repairManifest.summary,
    editablePaths: ['src/pricing/compute-unit-price.ts', 'tests/pricing.test.ts', 'src/pricing/quote-cache.ts', 'tests/quote-cache.test.ts'],
    capabilityIds: [],
    rev: 'rev_repair1',
    revAt: s(151),
    jobId: 'job_repair1',
    progress: 'Reproducer passes in both request orders. Cache key now holds productId and membershipTier.',
    progressAt: s(149),
    baseCandidateId: 'cand_full',
  }),
];

// ---------- check results ----------

function isolationObservations(failing: boolean): Observation[] {
  const step = (seq: number, n: number, customer: string, expected: number, observed: number): Observation[] => [
    { label: `seq${seq} step${n} ${customer} backpack status`, expected: 200, observed: 200, passed: true },
    { label: `seq${seq} step${n} ${customer} backpack unitPriceCents`, expected, observed, passed: expected === observed },
  ];
  return failing
    ? [...step(1, 1, 'member-1', 8000, 8000), ...step(1, 2, 'regular-1', 10000, 8000), ...step(2, 1, 'regular-1', 10000, 10000), ...step(2, 2, 'member-1', 8000, 10000)]
    : [...step(1, 1, 'member-1', 8000, 8000), ...step(1, 2, 'regular-1', 10000, 10000), ...step(2, 1, 'regular-1', 10000, 10000), ...step(2, 2, 'member-1', 8000, 8000)];
}

function genericObservations(checkId: string, n: number): Observation[] {
  return Array.from({ length: Math.min(n, 6) }, (_, i) => ({ label: `${checkId} assertion ${i + 1}`, expected: true, observed: true, passed: true }));
}

const CHECK_IDS = ['quote.contract', 'pricing.tiers', 'pricing.isolation', 'quote.quantity', 'cache.reuse', 'checkout.summary'] as const;
const ASSERTIONS: Record<string, number> = {
  'quote.contract': 14,
  'pricing.tiers': 12,
  'pricing.isolation': 8,
  'quote.quantity': 40,
  'cache.reuse': 6,
  'checkout.summary': 9,
};
const REQUIRES: Record<string, string | undefined> = { 'cache.reuse': 'quote-cache', 'checkout.summary': 'checkout-summary' };

function checks(candidateId: string, caps: string[], failed: string[] = [], state: Candidate['state'] = 'passed'): Candidate['checks'] {
  if (state === 'planned' || state === 'assembling') return [];
  return CHECK_IDS.map((checkId) => {
    const req = REQUIRES[checkId];
    const applicable = !req || caps.includes(req);
    const isFailed = failed.includes(checkId);
    const status = !applicable ? 'skipped' : state === 'testing' ? (checkId === 'pricing.isolation' ? 'running' : 'passed') : isFailed ? 'failed' : 'passed';
    return {
      id: `chk_${candidateId}_${checkId}`,
      checkId,
      status,
      applicable,
      applicabilityReason: applicable ? (req ? `capability ${req} is present` : 'universal invariant') : `capability ${req} is not in this candidate`,
      assertionCount: applicable && status !== 'running' ? ASSERTIONS[checkId]! : 0,
      failedCount: isFailed ? 2 : 0,
      attemptNo: 1,
      evidenceId: applicable && status !== 'running' ? `ev_chk_${candidateId}_${checkId}` : null,
    };
  });
}

function candidate(c: {
  id: string;
  label: string;
  members: string[];
  caps: string[];
  at: number;
  failed?: string[];
  state?: Candidate['state'];
  anchor?: string;
  promotable?: boolean;
}): Candidate {
  const state = c.state ?? (c.failed?.length ? 'failed' : 'passed');
  const fullGoal = ['membership-pricing', 'quote-cache', 'checkout-summary'].every((x) => c.caps.includes(x));
  return {
    id: c.id,
    label: c.label,
    state,
    headSha: state === 'planned' ? null : sha(c.id),
    treeSha: state === 'planned' ? null : sha(`${c.id}-tree`),
    repoName: `cand-${SESSION_ID}-int`,
    members: c.members,
    anchorCandidateId: c.anchor ?? null,
    capabilities: c.caps as Candidate['capabilities'],
    fullGoal,
    promotable: c.promotable ?? false,
    validationDigest: c.promotable ? digest(`${c.id}-validation`) : null,
    manifestDigest: state === 'planned' ? null : digest(`${c.id}-manifest`),
    error: null,
    createdAt: c.at,
    checks: checks(c.id, c.caps, c.failed, state),
  };
}

const ALL_CAPS = ['membership-pricing', 'quote-cache', 'checkout-summary'];
const CANDIDATES = (): Candidate[] => [
  candidate({ id: 'cand_baseline', label: 'Baseline', members: [], caps: [], at: s(6) }),
  candidate({ id: 'cand_pricing', label: 'Member pricing', members: ['rev_pricing'], caps: ['membership-pricing'], at: s(84) }),
  candidate({ id: 'cand_caching', label: 'Unit-price cache', members: ['rev_caching'], caps: ['quote-cache'], at: s(84) }),
  candidate({ id: 'cand_checkout', label: 'Checkout summary', members: ['rev_checkout'], caps: ['checkout-summary'], at: s(84) }),
  candidate({
    id: 'cand_pair',
    label: 'Member pricing + Unit-price cache',
    members: ['rev_pricing', 'rev_caching'],
    caps: ['membership-pricing', 'quote-cache'],
    at: s(84),
    failed: ['pricing.isolation'],
  }),
  candidate({
    id: 'cand_full',
    label: 'Member pricing + Unit-price cache + Checkout summary',
    members: ['rev_pricing', 'rev_caching', 'rev_checkout'],
    caps: ALL_CAPS,
    at: s(84),
    failed: ['pricing.isolation'],
  }),
  candidate({
    id: 'cand_repaired',
    label: 'Full goal + Repair 1',
    members: ['rev_pricing', 'rev_caching', 'rev_checkout', 'rev_repair1'],
    caps: ALL_CAPS,
    at: s(152),
    anchor: 'cand_full',
    promotable: true,
  }),
];

function checkResult(candidateId: string, checkId: string, status: CheckResult['status'], observations: Observation[], at: number): CheckResult {
  return {
    schemaVersion: 1,
    checkId,
    candidateId,
    candidateHeadSha: sha(candidateId),
    candidateManifestDigest: digest(`${candidateId}-manifest`),
    harnessDigest: digest('harness'),
    status,
    applicable: true,
    applicabilityReason: 'universal invariant',
    assertionCount: observations.length,
    failedCount: observations.filter((o) => !o.passed).length,
    observations,
    startedAt: at,
    finishedAt: at + 2400,
  };
}

const ISOLATION_FAILURE = () => checkResult('cand_pair', 'pricing.isolation', 'failed', isolationObservations(true), s(97));

function activity(): Snap['activity'] {
  const out: Snap['activity'] = [];
  const lane = (proposalId: string, startSec: number, plan: Array<[kind: string, label: string, dur: number, gap?: number]>) => {
    let t = startSec;
    plan.forEach(([kind, label, dur, gap = 0.4], i) => {
      out.push({ id: `act_${proposalId}_${i}`, proposalId, attemptNo: 1, kind, label, startedAt: s(t), finishedAt: s(t + dur) });
      t += dur + gap;
    });
  };
  lane('prop_pricing', 6.2, [
    ['model', 'model turn 1', 7.4], ['tool', 'read_file', 0.3], ['tool', 'declare_intent', 0.2], ['model', 'model turn 2', 9.1],
    ['tool', 'write_file', 0.2], ['tool', 'run_tests', 6.8], ['model', 'model turn 3', 8.2], ['tool', 'declare_intent', 0.2],
    ['tool', 'write_file', 0.2], ['tool', 'run_tests', 6.1], ['model', 'model turn 4', 5.5], ['tool', 'finish', 0.3],
  ]);
  lane('prop_caching', 6.5, [
    ['model', 'model turn 1', 6.2], ['tool', 'read_file', 0.3], ['tool', 'declare_intent', 0.2], ['model', 'model turn 2', 8.3],
    ['tool', 'write_file', 0.2], ['tool', 'run_tests', 6.4], ['model', 'model turn 3', 7.1], ['tool', 'finish', 0.3],
  ]);
  lane('prop_checkout', 6.9, [
    ['model', 'model turn 1', 8.8], ['tool', 'read_file', 0.4], ['tool', 'declare_intent', 0.2], ['model', 'model turn 2', 11.2],
    ['tool', 'write_file', 0.3], ['tool', 'write_file', 0.2], ['tool', 'run_tests', 9.6], ['model', 'model turn 3', 9.4],
    ['tool', 'run_tests', 8.8], ['model', 'model turn 4', 6.3], ['tool', 'finish', 0.3],
  ]);
  lane('prop_repair1', 106, [
    ['model', 'model turn 1', 9.6], ['tool', 'run_reproducer', 3.1], ['tool', 'declare_intent', 0.2], ['model', 'model turn 2', 10.4],
    ['tool', 'write_file', 0.2], ['tool', 'run_reproducer', 3.0], ['tool', 'run_tests', 6.6], ['model', 'model turn 3', 5.9], ['tool', 'finish', 0.3],
  ]);
  return out;
}

const BASE_SNAPSHOT = (): Snap => ({
  session: {
    id: SESSION_ID,
    objective: 'Add member pricing, cache unit-price calculations, and improve the checkout price breakdown without breaking nonmember prices.',
    mode: 'live',
    status: 'ready',
    baselineSha: BASELINE,
    expectedMainSha: BASELINE,
    taskSetDigest: digest('tasks'),
    policyDigest: digest('policy'),
    harnessDigest: digest('harness'),
    modelId: 'claude-opus-5-5',
    createdBy: 'operator@example.com',
    createdAt: T0,
    finishedAt: null,
    budget: { ceilingMicroUsd: 5_000_000, reserved: 0, spent: 1_284_317, uncertain: 0, total: 1_284_317 },
    reason: 'Full goal + Repair 1 passed every applicable check',
  },
  project: { slug: 'storefront', canonicalRepo: 'storefront-main', observedMainSha: BASELINE },
  limits: { maxRepairAttempts: 2, maxCandidates: 8, liveEnabled: true },
  proposals: PROPOSALS(),
  candidates: CANDIDATES(),
  interactions: [
    {
      id: 'ix_dimensions',
      kind: 'assumption',
      state: 'resolved',
      contractKey: 'unit-price.dimensions',
      leftProposalId: 'prop_pricing',
      rightProposalId: 'prop_caching',
      leftIntentDigest: digest('prop_pricing-intent'),
      rightIntentDigest: digest('prop_caching-intent'),
      explanation:
        'Member pricing changes unit-price.dimensions from ["productId"] to ["productId","membershipTier"]. Unit-price cache assumes unit-price.dimensions is a subset of ["productId"].',
      failedCandidateId: 'cand_pair',
      failedCheckRunId: 'chk_cand_pair_pricing.isolation',
      failedCheck: { checkId: 'pricing.isolation', result: ISOLATION_FAILURE() as unknown as Json },
      resolvedCandidateId: 'cand_repaired',
      resolutionCheckRunId: 'chk_cand_repaired_pricing.isolation',
    },
  ],
  approvals: [],
  promotions: [],
  activity: activity(),
  jobs: [
    { id: 'job_pricing', kind: 'agent', entityId: 'prop_pricing', status: 'succeeded', attemptNo: 1, errorCode: null },
    { id: 'job_caching', kind: 'agent', entityId: 'prop_caching', status: 'succeeded', attemptNo: 1, errorCode: null },
    { id: 'job_checkout', kind: 'agent', entityId: 'prop_checkout', status: 'succeeded', attemptNo: 1, errorCode: null },
    { id: 'job_repair1', kind: 'agent', entityId: 'prop_repair1', status: 'succeeded', attemptNo: 1, errorCode: null },
  ],
  watermark: 412,
});


/** A sample snapshot for one UI state. */
export function sampleSnapshot(variant: SampleVariant = 'ready'): Snap {
  const live = variant === 'running' || variant === 'cancelling' || variant === 'failed-agent';
  T0 = Date.now() - (live ? 40_000 : 10 * 60_000);
  const snap = BASE_SNAPSHOT();
  const final = snap.candidates.find((c) => c.id === 'cand_repaired')!;
  const approval = () => ({
    id: 'appr_sample',
    candidate_id: final.id,
    decision: 'approve',
    head_sha: final.headSha,
    validation_digest: final.validationDigest,
    expected_main_sha: BASELINE,
    actor_subject: 'operator@example.com',
    expires_at: s(3600),
    created_at: s(170),
  });
  switch (variant) {
    case 'ready':
      return snap;
    case 'approved':
      snap.approvals = [approval()];
      return snap;
    case 'promoted':
      snap.approvals = [approval()];
      snap.promotions = [
        { id: 'prom_sample', approval_id: 'appr_sample', state: 'succeeded', before_sha: BASELINE, target_sha: final.headSha, observed_remote_sha: final.headSha, created_at: s(175), updated_at: s(178) },
      ];
      snap.project!.observedMainSha = final.headSha;
      snap.session.status = 'promoted';
      snap.session.finishedAt = s(178);
      return snap;
    case 'stale':
      snap.project!.observedMainSha = sha('someone-else-pushed');
      return snap;
    case 'fixture': {
      snap.session.mode = 'fixture';
      snap.session.modelId = null;
      snap.session.budget = { ceilingMicroUsd: 0, reserved: 0, spent: 0, uncertain: 0, total: 0 };
      snap.activity = snap.proposals.map((p, i) => ({
        id: `act_fx_${p.id}`,
        proposalId: p.id,
        attemptNo: 1,
        kind: 'fixture',
        label: 'apply checked-in patch',
        startedAt: p.kind === 'repair' ? s(106) : s(6 + i * 0.2),
        finishedAt: p.kind === 'repair' ? s(109.5) : s(9.1 + i * 0.6),
      }));
      for (const p of snap.proposals) p.progress = { message: 'Fixture agent (no model call): sealed the checked-in patch', at: p.revisions[0]!.createdAt };
      return snap;
    }
    case 'running':
    case 'cancelling':
    case 'failed-agent': {
      const cut = s(40);
      snap.session.status = variant === 'failed-agent' ? 'needs_attention' : variant === 'cancelling' ? 'cancelled' : 'running';
      snap.session.reason = variant === 'failed-agent' ? 'Checkout summary agent stopped: BUDGET_EXCEEDED' : null;
      snap.proposals = snap.proposals.filter((p) => p.kind === 'feature');
      snap.candidates = snap.candidates.filter((c) => c.id === 'cand_baseline');
      snap.interactions = [
        { ...snap.interactions[0]!, state: 'predicted', failedCandidateId: null, failedCheckRunId: null, failedCheck: null, resolvedCandidateId: null, resolutionCheckRunId: null },
      ];
      snap.activity = snap.activity
        .filter((a) => a.startedAt < cut && a.proposalId !== 'prop_repair1')
        .map((a) => (a.finishedAt !== null && a.finishedAt > cut ? { ...a, finishedAt: null } : a));
      for (const p of snap.proposals) {
        p.status = 'working';
        p.revisions = [];
        p.job = { id: p.job!.id, status: 'running', attemptNo: 1, errorCode: null };
        p.progress = { message: p.role === 'pricing' ? 'Declared intent: unit price now depends on membershipTier. Editing compute-unit-price.ts.' : p.role === 'caching' ? 'Declared intent: cache key is productId. Writing quote-cache.ts.' : 'Reading the quote contract and the current summary component.', at: s(30) };
      }
      snap.jobs = snap.jobs.filter((j) => j.id !== 'job_repair1').map((j) => ({ ...j, status: 'running' }));
      snap.session.budget = { ceilingMicroUsd: 5_000_000, reserved: 450_000, spent: 612_880, uncertain: 18_400, total: 1_081_280 };
      if (variant === 'failed-agent') {
        const co = snap.proposals.find((p) => p.role === 'checkout')!;
        co.status = 'blocked';
        co.job = { id: co.job!.id, status: 'failed', attemptNo: 1, errorCode: 'BUDGET_EXCEEDED' };
        co.progress = { message: 'Stopped: the next model call needs more budget than the session has left.', at: s(39) };
        snap.jobs = snap.jobs.map((j) => (j.id === co.job!.id ? { ...j, status: 'failed', errorCode: 'BUDGET_EXCEEDED' } : j));
        snap.activity = snap.activity.map((a) => (a.proposalId === co.id && a.finishedAt === null ? { ...a, finishedAt: s(39) } : a));
        snap.session.budget = { ceilingMicroUsd: 1_000_000, reserved: 0, spent: 981_200, uncertain: 18_800, total: 1_000_000 };
      }
      return snap;
    }
  }
}

// ---------- detail endpoints ----------

export function sampleCandidateDetail(snap: Snap, id: string): CandidateDetail | null {
  const c = snap.candidates.find((x) => x.id === id);
  if (!c) return null;
  return {
    id: c.id,
    sessionId: snap.session.id,
    label: c.label,
    state: c.state,
    headSha: c.headSha,
    treeSha: c.treeSha,
    expectedMainSha: snap.session.expectedMainSha,
    observedMainSha: snap.project?.observedMainSha ?? null,
    manifest: null,
    manifestDigest: c.manifestDigest,
    validationDigest: c.validationDigest,
    promotable: c.promotable,
    fullGoal: c.fullGoal,
    capabilities: c.capabilities,
    anchorCandidateId: c.anchorCandidateId,
    members: c.members,
    checks: c.checks.map((k) => ({
      id: k.id,
      checkId: k.checkId,
      attemptNo: k.attemptNo,
      status: k.status,
      applicable: k.applicable,
      applicabilityReason: k.applicabilityReason,
      assertionCount: k.assertionCount,
      failedCount: k.failedCount,
      evidenceId: k.evidenceId,
      result:
        k.status === 'skipped' || k.status === 'running'
          ? null
          : k.checkId === 'pricing.isolation'
            ? checkResult(c.id, k.checkId, k.status === 'failed' ? 'failed' : 'passed', isolationObservations(k.status === 'failed'), c.createdAt + 12_000)
            : checkResult(c.id, k.checkId, 'passed', genericObservations(k.checkId, k.assertionCount), c.createdAt + 10_000),
    })),
  };
}

export function sampleProposalDetail(snap: Snap, id: string): ProposalDetail | null {
  const p = snap.proposals.find((x) => x.id === id);
  if (!p || !p.intent) return null;
  const intents: ProposalDetail['intents'] = [{ version: 1, intent: p.intent, digest: digest(`${p.id}-intent-v1`), createdAt: s(14) }];
  if ((p.intentVersion ?? 1) > 1) {
    intents.unshift({ version: 1, intent: { ...p.intent, contractChanges: p.intent.contractChanges.slice(0, 1) }, digest: digest(`${p.id}-intent-v0`), createdAt: s(13) });
    intents[1] = { ...intents[1]!, version: 2, createdAt: s(42) };
  }
  return {
    id: p.id,
    sessionId: snap.session.id,
    title: p.title,
    kind: p.kind,
    status: p.status,
    taskSpec: {
      id: `task-${p.role}`,
      title: p.title,
      role: p.role,
      objective: p.objective,
      capabilityIds: p.capabilityIds as ProposalDetail['taskSpec']['capabilityIds'],
      editablePaths: p.editablePaths,
      forbiddenPaths: ['src/server.ts', 'package.json'],
      requiredCheckIds: [...CHECK_IDS],
      preservedInvariantIds: [],
      baselineSha: BASELINE,
      ordinal: 0,
    },
    baseCandidateId: p.baseCandidateId,
    intents,
    revisions: p.revisions,
  };
}

const DIFFS: Record<string, string> = {
  caching: `diff --git a/src/pricing/quote-cache.ts b/src/pricing/quote-cache.ts
--- a/src/pricing/quote-cache.ts
+++ b/src/pricing/quote-cache.ts
@@ -1,9 +1,22 @@
-import type { UnitPriceFn } from '../quote-contract';
+import type { UnitPrice, UnitPriceFn, UnitPriceInput } from '../quote-contract';

 /**
- * Baseline: no caching. Every call reaches the underlying computation.
+ * Cache key: productId. The unit price varies only by product.
  */
 export function createUnitPriceCache(compute: UnitPriceFn): UnitPriceFn {
-  return (input) => compute(input);
+  const cache = new Map<string, UnitPrice>();
+  return (input: UnitPriceInput): UnitPrice => {
+    const key = input.productId;
+    let price = cache.get(key);
+    if (!price) {
+      price = compute(input);
+      cache.set(key, price);
+    }
+    return { ...price };
+  };
 }`,
  repair: `diff --git a/src/pricing/quote-cache.ts b/src/pricing/quote-cache.ts
--- a/src/pricing/quote-cache.ts
+++ b/src/pricing/quote-cache.ts
@@ -4,12 +4,19 @@
- * Cache key: productId. The unit price varies only by product.
+ * Cache key: every price-affecting dimension, productId and membershipTier.
+ * Member pricing made the unit price depend on membershipTier, so a key of
+ * productId alone served one tier's price to the other.
  */
+export function unitPriceCacheKey({ productId, customer }: UnitPriceInput): string {
+  return JSON.stringify([productId, customer.membershipTier]);
+}
+
 export function createUnitPriceCache(compute: UnitPriceFn): UnitPriceFn {
   const cache = new Map<string, UnitPrice>();
   return (input: UnitPriceInput): UnitPrice => {
-    const key = input.productId;
+    const key = unitPriceCacheKey(input);`,
  pricing: `diff --git a/src/pricing/compute-unit-price.ts b/src/pricing/compute-unit-price.ts
--- a/src/pricing/compute-unit-price.ts
+++ b/src/pricing/compute-unit-price.ts
@@ -1,8 +1,12 @@
+const MEMBER_DISCOUNT_PERCENT = 20;
+
 export function computeUnitPrice({ productId, customer }: UnitPriceInput): UnitPrice {
   const product = PRODUCTS[productId];
-  return { listPriceCents: product.listPriceCents, unitPriceCents: product.listPriceCents };
+  const discount = customer.membershipTier === 'member' ? MEMBER_DISCOUNT_PERCENT : 0;
+  const unit = product.listPriceCents - Math.round((product.listPriceCents * discount) / 100);
+  return { listPriceCents: product.listPriceCents, unitPriceCents: unit };
 }`,
  checkout: `diff --git a/src/ui/CheckoutSummary.tsx b/src/ui/CheckoutSummary.tsx
--- a/src/ui/CheckoutSummary.tsx
+++ b/src/ui/CheckoutSummary.tsx
@@ -3,6 +3,14 @@
-  return <p>Total: {formatCents(quote.totalCents)}</p>;
+  return (
+    <dl aria-label="Price breakdown">
+      <dt>List price</dt><dd>{formatCents(quote.listPriceCents)}</dd>
+      {quote.savingsCents > 0 && (<><dt>Member savings</dt><dd>-{formatCents(quote.savingsCents)}</dd></>)}
+      <dt>Unit price</dt><dd>{formatCents(quote.unitPriceCents)}</dd>
+      <dt>Quantity</dt><dd>{quote.quantity}</dd>
+      <dt>Total</dt><dd>{formatCents(quote.totalCents)}</dd>
+    </dl>
+  );`,
};

export function sampleEvidence(snap: Snap, id: string): EvidenceDto | null {
  const diff = /^ev_diff_(\w+)$/.exec(id);
  if (diff) {
    const text = DIFFS[diff[1]!] ?? '';
    return { id, kind: 'diff', sha256: digest(id), bytes: text.length, contentType: 'text/plain; charset=utf-8', verified: true, content: text };
  }
  const chk = /^ev_chk_(cand_\w+?)_(.+)$/.exec(id);
  if (chk) {
    const detail = sampleCandidateDetail(snap, chk[1]!);
    const result = detail?.checks.find((k) => k.checkId === chk[2])?.result ?? null;
    if (!result) return null;
    return { id, kind: 'check', sha256: digest(id), bytes: JSON.stringify(result).length, contentType: 'application/json', verified: true, content: result };
  }
  return null;
}

export function sampleEvents(snap: Snap): EventsPage {
  const events: EventsPage['events'] = [];
  let seq = 300;
  for (const p of snap.proposals) {
    const add = (type: string, at: number, payload: Record<string, unknown>) =>
      events.push({ seq: seq++, type, actor: 'system', entityType: 'proposal', entityId: p.id, payload, visibility: 'public', createdAt: at });
    const start = p.kind === 'repair' ? s(105) : s(6);
    add('agent.started', start, { mode: snap.session.mode });
    add('intent.updated', start + 9000, { version: 1, contractChanges: p.intent?.contractChanges ?? [], assumptions: p.intent?.assumptions ?? [] });
    add('agent.progress', start + 30_000, { message: p.progress?.message ?? 'working' });
    if (p.revisions[0]) add('revision.sealed', p.revisions[0].createdAt, { revisionNo: 1, headSha: p.revisions[0].headSha, changedPaths: p.editablePaths });
  }
  return { events: events.sort((a, b) => a.seq - b.seq), cursor: seq, hasMore: false };
}

/** A sample public replay, built with the same field whitelist as worker/replay.ts. */
export function sampleReplay(variant: SampleVariant = 'promoted'): PublicReplay {
  const snap = sampleSnapshot(variant);
  return {
    schemaVersion: 1,
    replayId: 'rpl_sample00000000000000000000',
    publishedAt: s(400),
    recordedAt: snap.session.createdAt,
    originalMode: snap.session.mode,
    session: {
      objective: snap.session.objective,
      mode: snap.session.mode,
      status: snap.session.status,
      baselineSha: snap.session.baselineSha,
      expectedMainSha: snap.session.expectedMainSha,
      createdAt: snap.session.createdAt,
      finishedAt: snap.session.finishedAt,
      taskSetDigest: snap.session.taskSetDigest,
      policyDigest: snap.session.policyDigest,
      harnessDigest: snap.session.harnessDigest,
      modelId: snap.session.modelId,
      budget: { spentMicroUsd: snap.session.budget.spent, uncertainMicroUsd: snap.session.budget.uncertain, ceilingMicroUsd: snap.session.budget.ceilingMicroUsd },
    },
    proposals: snap.proposals.map((p) => ({
      id: p.id,
      title: p.title,
      kind: p.kind,
      role: p.role,
      status: p.status,
      baseCandidateId: p.baseCandidateId,
      editablePaths: p.editablePaths,
      capabilityIds: p.capabilityIds,
      summary: p.summary,
      intent: p.intent ? { objective: p.intent.objective, contractChanges: p.intent.contractChanges, assumptions: p.intent.assumptions, affectedPaths: p.intent.affectedPaths } : null,
      revisions: p.revisions.map(({ id, revisionNo, baseSha, headSha, treeSha, intentDigest, dependencies, createdAt }) => ({ id, revisionNo, baseSha, headSha, treeSha, intentDigest, dependencies, createdAt })),
    })),
    candidates: snap.candidates.map((c) => ({
      id: c.id,
      label: c.label,
      state: c.state,
      headSha: c.headSha,
      treeSha: c.treeSha,
      members: c.members,
      anchorCandidateId: c.anchorCandidateId,
      capabilities: c.capabilities,
      fullGoal: c.fullGoal,
      promotable: c.promotable,
      validationDigest: c.validationDigest,
      manifestDigest: c.manifestDigest,
      createdAt: c.createdAt,
      checks: c.checks.map(({ checkId, status, applicable, applicabilityReason, assertionCount, failedCount, attemptNo }) => ({ checkId, status, applicable, applicabilityReason, assertionCount, failedCount, attemptNo })),
    })),
    interactions: snap.interactions.map((i) => ({
      id: i.id,
      kind: i.kind,
      state: i.state,
      contractKey: i.contractKey,
      leftProposalId: i.leftProposalId,
      rightProposalId: i.rightProposalId,
      explanation: i.explanation,
      failedCandidateId: i.failedCandidateId,
      resolvedCandidateId: i.resolvedCandidateId,
      failedCheck: i.failedCheck ? { checkId: i.failedCheck.checkId, observations: ((i.failedCheck.result as { observations?: unknown[] }).observations ?? []).slice(0, 24) } : null,
    })),
    promotions: snap.promotions.map((p) => ({ state: p.state, targetSha: p.target_sha, beforeSha: p.before_sha, observedRemoteSha: p.observed_remote_sha })),
    approvals: snap.approvals.map((a) => ({ decision: a.decision, headSha: a.head_sha, validationDigest: a.validation_digest, createdAt: a.created_at })),
    activity: snap.activity.map(({ proposalId, kind, label, startedAt, finishedAt }) => ({ proposalId, kind, label, startedAt, finishedAt })),
    events: sampleEvents(snap).events.map(({ seq, type, entityType, entityId, createdAt, payload }) => ({ seq, type, entityType, entityId, createdAt, payload })),
  };
}
