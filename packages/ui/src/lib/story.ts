import { CHECKS } from '@converge/domain/catalog';
import type { Observation } from '@converge/domain';
import { formatValue } from './format.ts';
import { proposalName, type SessionView, type ViewCandidate, type ViewInteraction, type ViewProposal } from './view.ts';

// The causal story of an interaction, built only from recorded intents and check observations.

export type StoryLink =
  | { kind: 'intent'; proposalId: string }
  | { kind: 'check'; candidateId: string; checkId: string }
  | { kind: 'candidate'; candidateId: string };

export interface StoryLine {
  role: 'declared' | 'assumed' | 'observed' | 'action' | 'verified';
  label: string;
  text: string;
  link?: StoryLink;
}

export interface SequenceStep {
  sequence: number;
  step: number;
  customer: string;
  product: string;
  field: string;
  expected: unknown;
  observed: unknown;
  passed: boolean;
}

const SEQ_LABEL = /^seq(\d+) step(\d+) (\S+) (\S+) (\S+)$/;

/** Parse request-sequence observations ("seq1 step2 regular-1 backpack unitPriceCents"). */
export function parseSequence(observations: readonly Observation[]): SequenceStep[] {
  const out: SequenceStep[] = [];
  for (const o of observations) {
    const m = SEQ_LABEL.exec(o.label);
    if (!m) continue;
    out.push({
      sequence: Number(m[1]),
      step: Number(m[2]),
      customer: m[3]!,
      product: m[4]!,
      field: m[5]!,
      expected: o.expected,
      observed: o.observed,
      passed: o.passed,
    });
  }
  return out.sort((a, b) => a.sequence - b.sequence || a.step - b.step);
}

export function customerTier(customerId: string): string {
  if (customerId.startsWith('member')) return 'member';
  if (customerId.startsWith('regular')) return 'regular';
  return customerId;
}

/** One plain sentence for the first failed observation. */
export function describeFailure(observations: readonly Observation[]): string | null {
  const failed = observations.find((o) => !o.passed);
  if (!failed) return null;
  const steps = parseSequence(observations);
  const step = steps.find((s) => s.field !== 'status' && !s.passed);
  if (step) {
    const before = steps.filter((s) => s.sequence === step.sequence && s.step < step.step && s.field !== 'status');
    const prior = before.length ? `after a ${customerTier(before[before.length - 1]!.customer)} quote, ` : '';
    const subject = customerTier(step.customer) === 'member' ? 'a member' : `a ${customerTier(step.customer)} customer`;
    return `${prior}${subject} received ${formatValue(step.observed)} instead of ${formatValue(step.expected)}`;
  }
  return `${failed.label}: expected ${formatValue(failed.expected)}, observed ${formatValue(failed.observed)}`;
}

const TOPICS: Record<string, string> = {
  'unit-price.dimensions': 'customer context',
  'membership.discount-percent': 'the member discount',
  'quote.response-version': 'the quote response contract',
  'unit-price.currency': 'currency',
};

export function topicOf(contractKey: string | null): string {
  if (!contractKey) return 'combined behavior';
  return TOPICS[contractKey] ?? contractKey;
}

export function checkTitle(checkId: string): string {
  return CHECKS.find((c) => c.id === checkId)?.title ?? checkId;
}

export interface InteractionStory {
  interaction: ViewInteraction;
  headline: string;
  outcome: 'predicted' | 'confirmed' | 'resolved' | 'unknown';
  left: ViewProposal | undefined;
  right: ViewProposal | undefined;
  failedCandidate: ViewCandidate | undefined;
  anchorCandidate: ViewCandidate | undefined;
  resolvedCandidate: ViewCandidate | undefined;
  repair: ViewProposal | undefined;
  lines: StoryLine[];
  sequence: SequenceStep[];
}

export function buildStory(view: Pick<SessionView, 'proposals' | 'candidates'>, i: ViewInteraction): InteractionStory {
  const left = view.proposals.find((p) => p.id === i.leftProposalId);
  const right = view.proposals.find((p) => p.id === i.rightProposalId);
  const failedCandidate = view.candidates.find((c) => c.id === i.failedCandidateId);
  const resolvedCandidate = view.candidates.find((c) => c.id === i.resolvedCandidateId);
  // A repair anchors on the failed candidate, or on a larger failed candidate that contains it.
  const failedMembers = failedCandidate?.members ?? [];
  const repair = i.failedCandidateId
    ? (view.proposals.find((p) => p.kind === 'repair' && p.baseCandidateId === i.failedCandidateId) ??
      view.proposals.find((p) => {
        if (p.kind !== 'repair' || !p.baseCandidateId) return false;
        const base = view.candidates.find((c) => c.id === p.baseCandidateId);
        return !!base && failedMembers.length > 0 && failedMembers.every((m) => base.members.includes(m));
      }))
    : undefined;
  const leftName = left ? proposalName(left) : 'One agent';
  const rightName = right ? proposalName(right) : 'another agent';
  const lines: StoryLine[] = [];

  const change = left?.intent?.contractChanges.find((c) => c.key === i.contractKey) ?? left?.intent?.contractChanges[0];
  if (left) {
    lines.push({
      role: 'declared',
      label: `Declared by ${leftName}`,
      text: change ? change.explanation : (left.summary ?? left.intent?.objective ?? left.title),
      link: { kind: 'intent', proposalId: left.id },
    });
  }
  const assumption = right?.intent?.assumptions.find((a) => a.key === (i.contractKey ?? change?.key)) ?? right?.intent?.assumptions[0];
  if (right) {
    lines.push({
      role: 'assumed',
      label: `Assumed by ${rightName}`,
      text: assumption ? assumption.rationale : (right.summary ?? right.intent?.objective ?? right.title),
      link: { kind: 'intent', proposalId: right.id },
    });
  }
  const observations = i.failedCheck?.observations ?? [];
  const failure = describeFailure(observations);
  if (i.failedCheck && i.failedCandidateId) {
    lines.push({
      role: 'observed',
      label: 'Observed',
      text: failure ?? `${checkTitle(i.failedCheck.checkId)} failed on ${failedCandidate?.label ?? 'the combined candidate'}`,
      link: { kind: 'check', candidateId: i.failedCandidateId, checkId: i.failedCheck.checkId },
    });
  }
  if (i.state === 'confirmed' || i.state === 'resolved') {
    if (repair) {
      const verb = repair.status === 'sealed' ? 'repaired' : repair.status === 'working' || repair.status === 'pending' ? 'repair in progress' : `repair ${repair.status}`;
      lines.push({
        role: 'action',
        label: 'Action',
        text: `${verb}: ${repair.intent?.objective ?? repair.summary ?? 'repair the failed combination while preserving each goal'}`,
        link: { kind: 'intent', proposalId: repair.id },
      });
    } else {
      lines.push({ role: 'action', label: 'Action', text: 'request a repair that fixes this counterexample and keeps each original goal' });
    }
  }
  if (i.state === 'resolved' && resolvedCandidate) {
    lines.push({
      role: 'verified',
      label: 'Repair verified',
      text: `${resolvedCandidate.label} passes ${i.failedCheck ? checkTitle(i.failedCheck.checkId) : 'the failed check'} and every other applicable check`,
      link: { kind: 'candidate', candidateId: resolvedCandidate.id },
    });
  }

  const topic = topicOf(i.contractKey ?? change?.key ?? null);
  const outcome = (['predicted', 'confirmed', 'resolved'].includes(i.state) ? i.state : 'unknown') as InteractionStory['outcome'];
  const headline =
    outcome === 'resolved'
      ? 'Repair verified'
      : outcome === 'confirmed'
        ? 'A reproducible failure was found'
        : outcome === 'predicted'
          ? `${leftName} and ${rightName.toLowerCase()} disagree about ${topic}`
          : `${leftName} and ${rightName.toLowerCase()} may interact`;
  const anchorCandidate = repair?.baseCandidateId ? view.candidates.find((c) => c.id === repair.baseCandidateId) : failedCandidate;
  return { interaction: i, headline, outcome, left, right, failedCandidate, anchorCandidate, resolvedCandidate, repair, lines, sequence: parseSequence(observations) };
}

/** Lead outcome for a whole session, for the header. */
export function sessionOutcome(view: Pick<SessionView, 'session' | 'interactions' | 'candidates' | 'promotions' | 'proposals'>): string {
  const s = view.session.status;
  if (view.promotions.some((p) => p.state === 'succeeded')) return 'Main now equals the approved commit';
  if (s === 'cancelled') return 'Session cancelled';
  if (s === 'failed') return 'Session failed';
  if (s === 'needs_attention') return 'The session needs your attention';
  if (s === 'ready') return 'Ready to approve this commit';
  if (view.interactions.some((i) => i.state === 'resolved')) return 'Repair verified';
  if (view.interactions.some((i) => i.state === 'confirmed')) return 'A reproducible failure was found';
  const predicted = view.interactions.find((i) => i.state === 'predicted');
  if (predicted) return buildStory(view, predicted).headline;
  if (s === 'created') return 'Session ready to start';
  if (s === 'validating') return 'Checks run on the combined candidates';
  return 'Agents work in parallel';
}
