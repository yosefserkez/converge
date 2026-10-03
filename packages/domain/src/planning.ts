import { digestOf } from './canonical.ts';
import { DomainError } from './errors.ts';
import { compareNumbers, compareStrings, sortedUnique } from './order.ts';
import type { Capability, RevisionRef, TaskSpec } from './schemas.ts';
import { CandidatePlan } from './schemas.ts';

export type OrderedRevision = RevisionRef & { ordinal: number };

function byOrdinalThenId(a: { ordinal: number; revisionId: string }, b: { ordinal: number; revisionId: string }): number {
  return compareNumbers(a.ordinal, b.ordinal) || compareStrings(a.revisionId, b.revisionId);
}

function indexById<T extends { revisionId: string }>(revisions: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of revisions) {
    if (map.has(r.revisionId)) {
      throw new DomainError('INVALID_INPUT', `duplicate revision ${r.revisionId}`, { revisionId: r.revisionId });
    }
    map.set(r.revisionId, r);
  }
  return map;
}

/**
 * Deterministic topological order (Kahn), ties broken by (ordinal, revisionId).
 * Dependencies outside the set are rejected unless listed in `satisfiedRevisionIds`
 * (for example, revisions already contained in an assembly anchor).
 */
export function topoSortRevisions<T extends Pick<OrderedRevision, 'revisionId' | 'ordinal' | 'dependencyRevisionIds'>>(
  revisions: readonly T[],
  options: { satisfiedRevisionIds?: Iterable<string> } = {},
): T[] {
  const byId = indexById(revisions);
  const satisfied = new Set(options.satisfiedRevisionIds ?? []);
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const r of revisions) {
    let count = 0;
    for (const dep of new Set(r.dependencyRevisionIds)) {
      if (dep === r.revisionId) {
        throw new DomainError('DEPENDENCY_CYCLE', `revision ${r.revisionId} depends on itself`, { revisionIds: [r.revisionId] });
      }
      if (byId.has(dep)) {
        count++;
        dependents.set(dep, [...(dependents.get(dep) ?? []), r.revisionId]);
      } else if (!satisfied.has(dep)) {
        throw new DomainError('INVALID_INPUT', `revision ${r.revisionId} depends on ${dep}, which is not in the plan`, {
          revisionId: r.revisionId,
          missing: dep,
        });
      }
    }
    indegree.set(r.revisionId, count);
  }
  const ready = revisions.filter((r) => indegree.get(r.revisionId) === 0);
  const out: T[] = [];
  while (ready.length > 0) {
    ready.sort(byOrdinalThenId);
    const next = ready.shift()!;
    out.push(next);
    for (const id of dependents.get(next.revisionId) ?? []) {
      const left = indegree.get(id)! - 1;
      indegree.set(id, left);
      if (left === 0) ready.push(byId.get(id)!);
    }
  }
  if (out.length !== revisions.length) {
    const stuck = sortedUnique(revisions.filter((r) => (indegree.get(r.revisionId) ?? 0) > 0).map((r) => r.revisionId));
    throw new DomainError('DEPENDENCY_CYCLE', `dependency cycle among ${stuck.join(', ')}`, { revisionIds: stuck });
  }
  return out;
}

/** Selected revisions plus every transitive dependency, in input order. */
export function dependencyClosure<T extends Pick<RevisionRef, 'revisionId' | 'dependencyRevisionIds'>>(
  selectedIds: Iterable<string>,
  all: readonly T[],
  options: { satisfiedRevisionIds?: Iterable<string> } = {},
): T[] {
  const byId = indexById(all);
  const satisfied = new Set(options.satisfiedRevisionIds ?? []);
  const included = new Set<string>();
  const stack = [...selectedIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (included.has(id) || satisfied.has(id)) continue;
    const rev = byId.get(id);
    if (!rev) throw new DomainError('INVALID_INPUT', `unknown revision ${id}`, { revisionId: id });
    included.add(id);
    stack.push(...rev.dependencyRevisionIds);
  }
  return all.filter((r) => included.has(r.revisionId));
}

export interface BuildCandidatePlanInput {
  sessionId: string;
  label: string;
  baselineSha: string;
  expectedMainSha: string;
  taskSetDigest: string;
  members: readonly OrderedRevision[];
  anchor?: { candidateId: string; headSha: string; includedRevisionIds: readonly string[] };
  harnessDigest: string;
  policyDigest: string;
  environmentDigest: string;
}

/**
 * Validated plan with members in deterministic topological order.
 * Members outside the anchor must start from the session baseline or, for an
 * additive repair, from the anchor head. Anchor members were validated when the
 * anchor candidate was planned, so their base is not re-checked here.
 */
export function buildCandidatePlan(input: BuildCandidatePlanInput): CandidatePlan {
  const memberIds = new Set(input.members.map((m) => m.revisionId));
  const anchorIds = sortedUnique(input.anchor?.includedRevisionIds ?? []);
  const outside = anchorIds.filter((id) => !memberIds.has(id));
  if (outside.length > 0) {
    throw new DomainError('INVALID_INPUT', `anchor includes revisions that are not plan members: ${outside.join(', ')}`, {
      revisionIds: outside,
    });
  }
  const inAnchor = new Set(anchorIds);
  for (const m of input.members) {
    if (inAnchor.has(m.revisionId)) continue;
    const okBase = m.baseSha === input.baselineSha || (input.anchor !== undefined && m.baseSha === input.anchor.headSha);
    if (!okBase) {
      throw new DomainError('INVALID_INPUT', `revision ${m.revisionId} is not based on the session baseline or the anchor head`, {
        revisionId: m.revisionId,
        baseSha: m.baseSha,
      });
    }
  }
  const ordered = topoSortRevisions(input.members);
  const parsed = CandidatePlan.safeParse({
    schemaVersion: 1,
    sessionId: input.sessionId,
    label: input.label,
    baselineSha: input.baselineSha,
    expectedMainSha: input.expectedMainSha,
    taskSetDigest: input.taskSetDigest,
    members: ordered.map(({ ordinal: _ordinal, ...ref }) => ref),
    ...(input.anchor
      ? { anchor: { candidateId: input.anchor.candidateId, headSha: input.anchor.headSha, includedRevisionIds: anchorIds } }
      : {}),
    harnessDigest: input.harnessDigest,
    policyDigest: input.policyDigest,
    environmentDigest: input.environmentDigest,
  });
  if (!parsed.success) {
    throw new DomainError('INVALID_INPUT', 'invalid candidate plan', { issues: parsed.error.issues.map((i) => i.message) });
  }
  return parsed.data;
}

/**
 * Plan identity. The display label is excluded: labels must never become a
 * verification input, so two plans that differ only in label share a key.
 */
export async function planKey(plan: CandidatePlan): Promise<string> {
  const { label: _label, ...identity } = plan;
  return digestOf(identity);
}

export interface StandaloneRevision {
  proposalId: string;
  revisionId: string;
  ordinal: number;
}

export interface InitialCandidate {
  kind: 'baseline' | 'standalone' | 'pair' | 'full';
  label: string;
  proposalIds: string[];
  revisionIds: string[];
}

/**
 * Baseline, each standalone proposal, the highest-risk pair, and the full goal.
 * Pair risk counts predicted assumption/shared-write interactions (file overlap
 * is not semantic). The full combination always survives the cap.
 */
export function selectInitialCandidates(input: {
  standalone: readonly StandaloneRevision[];
  interactions: ReadonlyArray<{ kind: string; state: string; leftProposalId: string; rightProposalId: string }>;
  labels: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  maxCandidates: number;
}): InitialCandidate[] {
  if (!Number.isInteger(input.maxCandidates) || input.maxCandidates < 1) {
    throw new DomainError('INVALID_INPUT', 'maxCandidates must be a positive integer');
  }
  const proposals = [...input.standalone].sort(
    (a, b) => compareNumbers(a.ordinal, b.ordinal) || compareStrings(a.proposalId, b.proposalId),
  );
  if (new Set(proposals.map((p) => p.proposalId)).size !== proposals.length) {
    throw new DomainError('INVALID_INPUT', 'one standalone revision per proposal');
  }
  const labelOf = (id: string): string =>
    (input.labels instanceof Map ? input.labels.get(id) : (input.labels as Record<string, string>)[id]) ?? id;
  const make = (kind: InitialCandidate['kind'], members: readonly StandaloneRevision[], label?: string): InitialCandidate => ({
    kind,
    label: label ?? members.map((m) => labelOf(m.proposalId)).join(' + '),
    proposalIds: members.map((m) => m.proposalId),
    revisionIds: members.map((m) => m.revisionId),
  });

  const others: InitialCandidate[] = [make('baseline', [], 'Baseline')];
  if (proposals.length > 1) for (const p of proposals) others.push(make('standalone', [p]));

  if (proposals.length > 2) {
    const risk = (a: string, b: string) =>
      input.interactions.filter(
        (i) =>
          i.state === 'predicted' &&
          (i.kind === 'assumption' || i.kind === 'shared_write') &&
          ((i.leftProposalId === a && i.rightProposalId === b) || (i.leftProposalId === b && i.rightProposalId === a)),
      ).length;
    let best: [StandaloneRevision, StandaloneRevision] = [proposals[0]!, proposals[1]!];
    let bestRisk = risk(best[0].proposalId, best[1].proposalId);
    for (let i = 0; i < proposals.length; i++) {
      for (let j = i + 1; j < proposals.length; j++) {
        const r = risk(proposals[i]!.proposalId, proposals[j]!.proposalId);
        if (r > bestRisk) {
          bestRisk = r;
          best = [proposals[i]!, proposals[j]!];
        }
      }
    }
    others.push(make('pair', best));
  }

  // With no proposals the baseline is the full goal.
  if (proposals.length === 0) return others;
  return [...others.slice(0, input.maxCandidates - 1), make('full', proposals)];
}

/** Capabilities come only from controller-assigned feature tasks; repairs add none. */
export function capabilitiesOf(
  memberRevisionIds: Iterable<string>,
  revisionToTask: ReadonlyMap<string, string>,
  tasks: readonly TaskSpec[],
): Set<Capability> {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const caps = new Set<Capability>();
  for (const revisionId of memberRevisionIds) {
    const taskId = revisionToTask.get(revisionId);
    const task = taskId === undefined ? undefined : taskById.get(taskId);
    if (!task) throw new DomainError('INVALID_INPUT', `no task for revision ${revisionId}`, { revisionId });
    if (task.role === 'repair') continue;
    for (const c of task.capabilityIds) caps.add(c);
  }
  return caps;
}
