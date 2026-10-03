import { z } from 'zod';
import { canonicalJson } from './canonical.ts';
import { compareNumbers, compareStrings, sortedUnique } from './order.ts';
import type { Assumption, BaselineFacts, ChangeIntent, FactValue } from './schemas.ts';
import { ContractKey, Digest, Id } from './schemas.ts';

// Deterministic interaction detection (brief §7). Generic over contract keys
// and predicates: nothing here knows about specific agents or facts.

export type AssumptionResult = 'holds' | 'violated' | 'unknown';

function sameFact(a: FactValue, b: FactValue): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function isStringList(v: FactValue | undefined): v is string[] {
  return Array.isArray(v);
}

export function evaluateAssumption(assumption: Assumption, actual: FactValue | undefined): AssumptionResult {
  if (actual === undefined) return 'unknown';
  switch (assumption.operator) {
    case 'eq':
      return sameFact(assumption.expected, actual) ? 'holds' : 'violated';
    case 'subset_of': {
      if (!isStringList(actual)) return 'unknown';
      const allowed = new Set(assumption.expected);
      return actual.every((v) => allowed.has(v)) ? 'holds' : 'violated';
    }
    case 'contains':
      if (!isStringList(actual)) return 'unknown';
      return actual.includes(assumption.expected) ? 'holds' : 'violated';
  }
}

export const DetectedInteractionKind = z.enum(['assumption', 'shared_write', 'file_overlap']);
export type DetectedInteractionKind = z.infer<typeof DetectedInteractionKind>;

export const PredictedInteraction = z.object({
  kind: DetectedInteractionKind,
  state: z.enum(['predicted', 'unknown']),
  contractKey: ContractKey.optional(),
  leftProposalId: Id,
  rightProposalId: Id,
  leftRevisionId: Id.optional(),
  rightRevisionId: Id.optional(),
  leftIntentDigest: Digest,
  rightIntentDigest: Digest,
  explanation: z.string().min(1),
  dedupeKey: z.string().min(1),
});
export type PredictedInteraction = z.infer<typeof PredictedInteraction>;

export interface ProposalIntent {
  proposalId: string;
  intentDigest: string;
  intent: ChangeIntent;
  ordinal: number;
  revisionId?: string;
}

export function formatFact(value: FactValue | undefined): string {
  if (value === undefined) return '(missing)';
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return JSON.stringify(value);
}

function baselineAgrees(baseline: BaselineFacts, key: string, before: FactValue): boolean {
  const fact = baseline[key];
  return fact === undefined ? before === null : sameFact(fact, before);
}

const KIND_RANK: Record<DetectedInteractionKind, number> = { assumption: 0, shared_write: 1, file_overlap: 2 };

function byOrder(a: ProposalIntent, b: ProposalIntent): number {
  return compareNumbers(a.ordinal, b.ordinal) || compareStrings(a.proposalId, b.proposalId);
}

function party(p: ProposalIntent): string {
  return `${p.proposalId}:${p.intentDigest}`;
}

/** Symmetric kinds sort the pair; assumption keeps changer>assumer direction. */
function dedupeKeyFor(kind: DetectedInteractionKind, key: string | undefined, left: ProposalIntent, right: ProposalIntent): string {
  const parties = kind === 'assumption' ? `${party(left)}>${party(right)}` : [party(left), party(right)].sort(compareStrings).join('|');
  return `${kind}|${key ?? '-'}|${parties}`;
}

function makeInteraction(
  kind: DetectedInteractionKind,
  state: 'predicted' | 'unknown',
  contractKey: string | undefined,
  left: ProposalIntent,
  right: ProposalIntent,
  explanation: string,
): PredictedInteraction {
  return {
    kind,
    state,
    ...(contractKey !== undefined ? { contractKey } : {}),
    leftProposalId: left.proposalId,
    rightProposalId: right.proposalId,
    ...(left.revisionId !== undefined ? { leftRevisionId: left.revisionId } : {}),
    ...(right.revisionId !== undefined ? { rightRevisionId: right.revisionId } : {}),
    leftIntentDigest: left.intentDigest,
    rightIntentDigest: right.intentDigest,
    explanation,
    dedupeKey: dedupeKeyFor(kind, contractKey, left, right),
  };
}

function assumptionInteractions(baseline: BaselineFacts, proposals: readonly ProposalIntent[]): PredictedInteraction[] {
  const out: PredictedInteraction[] = [];
  for (const changer of proposals) {
    const keys = sortedUnique(changer.intent.contractChanges.map((c) => c.key));
    for (const key of keys) {
      const changes = changer.intent.contractChanges.filter((c) => c.key === key);
      for (const assumer of proposals) {
        if (assumer.proposalId === changer.proposalId) continue;
        const assumptions = assumer.intent.assumptions.filter((a) => a.key === key);
        if (assumptions.length === 0) continue;
        let violated = false;
        let unknown = false;
        const parts: string[] = [];
        for (const change of changes) {
          const contested = !baselineAgrees(baseline, key, change.before);
          for (const a of assumptions) {
            const result = evaluateAssumption(a, change.after);
            const claim = `${changer.proposalId} changes ${key} to ${formatFact(change.after)}; ${assumer.proposalId} assumes ${a.operator} ${formatFact(a.expected)}.`;
            if (result === 'violated') {
              violated = true;
              parts.push(claim);
            } else if (result === 'unknown') {
              unknown = true;
              parts.push(`${claim} The assumption cannot be evaluated against that value.`);
            } else if (contested) {
              unknown = true;
              parts.push(
                `${claim} ${changer.proposalId} expects ${key} to be ${formatFact(change.before)} before its change, but the baseline is ${formatFact(baseline[key])}; the fact is contested.`,
              );
            }
          }
        }
        if (!violated && !unknown) continue;
        out.push(makeInteraction('assumption', violated ? 'predicted' : 'unknown', key, changer, assumer, parts.join(' ')));
      }
    }
  }
  return out;
}

function distinctAfters(p: ProposalIntent, key: string): FactValue[] {
  const seen = new Map<string, FactValue>();
  for (const c of p.intent.contractChanges) if (c.key === key) seen.set(canonicalJson(c.after), c.after);
  return [...seen.values()];
}

function sharedWriteInteractions(proposals: readonly ProposalIntent[]): PredictedInteraction[] {
  const out: PredictedInteraction[] = [];
  for (let i = 0; i < proposals.length; i++) {
    for (let j = i + 1; j < proposals.length; j++) {
      const left = proposals[i]!;
      const right = proposals[j]!;
      const leftKeys = new Set(left.intent.contractChanges.map((c) => c.key));
      const shared = sortedUnique(right.intent.contractChanges.map((c) => c.key)).filter((k) => leftKeys.has(k));
      for (const key of shared) {
        const la = distinctAfters(left, key);
        const ra = distinctAfters(right, key);
        const values = new Set([...la, ...ra].map((v) => canonicalJson(v)));
        if (values.size < 2) continue;
        out.push(
          makeInteraction(
            'shared_write',
            'predicted',
            key,
            left,
            right,
            `${left.proposalId} sets ${key} to ${la.map(formatFact).join(' or ')}; ${right.proposalId} sets it to ${ra.map(formatFact).join(' or ')}. Order does not resolve this; it needs evidence, a dependency, or a repair.`,
          ),
        );
      }
    }
  }
  return out;
}

function fileOverlapInteractions(proposals: readonly ProposalIntent[]): PredictedInteraction[] {
  const out: PredictedInteraction[] = [];
  for (let i = 0; i < proposals.length; i++) {
    for (let j = i + 1; j < proposals.length; j++) {
      const left = proposals[i]!;
      const right = proposals[j]!;
      const leftPaths = new Set(left.intent.affectedPaths);
      const overlap = sortedUnique(right.intent.affectedPaths).filter((p) => leftPaths.has(p));
      if (overlap.length === 0) continue;
      out.push(
        makeInteraction(
          'file_overlap',
          'predicted',
          undefined,
          left,
          right,
          `${left.proposalId} and ${right.proposalId} both declare edits to ${overlap.join(', ')}. File overlap is a merge signal, not a semantic conflict.`,
        ),
      );
    }
  }
  return out;
}

export function detectInteractions(input: {
  baselineFacts: BaselineFacts;
  proposals: readonly ProposalIntent[];
}): PredictedInteraction[] {
  const proposals = [...input.proposals].sort(byOrder);
  const ordinal = new Map(proposals.map((p, i) => [p.proposalId, i]));
  const all = [
    ...assumptionInteractions(input.baselineFacts, proposals),
    ...sharedWriteInteractions(proposals),
    ...fileOverlapInteractions(proposals),
  ];
  const unique = new Map<string, PredictedInteraction>();
  for (const it of all) if (!unique.has(it.dedupeKey)) unique.set(it.dedupeKey, it);
  return [...unique.values()].sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      compareStrings(a.contractKey ?? '', b.contractKey ?? '') ||
      (ordinal.get(a.leftProposalId) ?? 0) - (ordinal.get(b.leftProposalId) ?? 0) ||
      (ordinal.get(a.rightProposalId) ?? 0) - (ordinal.get(b.rightProposalId) ?? 0) ||
      compareStrings(a.dedupeKey, b.dedupeKey),
  );
}

export interface EffectiveFact {
  key: string;
  baseline: FactValue | undefined;
  /** Single resulting value; undefined when writers disagree or the fact is missing. */
  value: FactValue | undefined;
  contested: boolean;
  reasons: string[];
  writers: Array<{ proposalId: string; after: FactValue }>;
}

/** Display-only view of facts after applying every declared change. */
export function effectiveFacts(
  baselineFacts: BaselineFacts,
  intents: ReadonlyArray<{ proposalId: string; intent: ChangeIntent }>,
): EffectiveFact[] {
  const ordered = [...intents].sort((a, b) => compareStrings(a.proposalId, b.proposalId));
  const keys = sortedUnique([
    ...Object.keys(baselineFacts),
    ...ordered.flatMap((i) => i.intent.contractChanges.map((c) => c.key)),
  ]);
  return keys.map((key) => {
    const baseline = baselineFacts[key];
    const writers: EffectiveFact['writers'] = [];
    const reasons: string[] = [];
    for (const { proposalId, intent } of ordered) {
      for (const c of intent.contractChanges) {
        if (c.key !== key) continue;
        writers.push({ proposalId, after: c.after });
        if (!baselineAgrees(baselineFacts, key, c.before)) {
          reasons.push(`${proposalId} expects ${formatFact(c.before)} before its change; baseline is ${formatFact(baseline)}.`);
        }
      }
    }
    const afters = new Set(writers.map((w) => canonicalJson(w.after)));
    if (afters.size > 1) reasons.push(`Writers disagree: ${writers.map((w) => `${w.proposalId}=${formatFact(w.after)}`).join(', ')}.`);
    const value = writers.length === 0 ? baseline : afters.size === 1 ? writers[0]!.after : undefined;
    return { key, baseline, value, contested: reasons.length > 0, reasons, writers };
  });
}
