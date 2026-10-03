import { describe, expect, it } from 'vitest';
import {
  ALL_CAPABILITIES,
  BASELINE_FACTS,
  buildCandidatePlan,
  capabilitiesOf,
  detectInteractions,
  dependencyClosure,
  DomainError,
  planKey,
  selectInitialCandidates,
  STOREFRONT_TASKS,
  type TaskSpec,
  topoSortRevisions,
} from '../src/index.ts';
import { cachingIntent, checkoutIntent, dg, pricingIntent, rev, sha } from './fixtures.ts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : 'non-domain';
  }
  return undefined;
}

describe('topoSortRevisions', () => {
  it('orders dependencies first with (ordinal, revisionId) ties', () => {
    const order = topoSortRevisions([rev('r-repair', 3, ['r-pricing', 'r-caching']), rev('r-checkout', 2), rev('r-caching', 1), rev('r-pricing', 0), rev('r-aaa', 1)]);
    expect(order.map((r) => r.revisionId)).toEqual(['r-pricing', 'r-aaa', 'r-caching', 'r-checkout', 'r-repair']);
  });

  it('prefers a ready low-ordinal revision over a later dependency chain', () => {
    const order = topoSortRevisions([rev('r-b', 0, ['r-c']), rev('r-c', 5), rev('r-a', 1)]);
    expect(order.map((r) => r.revisionId)).toEqual(['r-a', 'r-c', 'r-b']);
  });

  it('rejects cycles and self-dependencies', () => {
    expect(codeOf(() => topoSortRevisions([rev('r-a', 0, ['r-b']), rev('r-b', 1, ['r-a'])]))).toBe('DEPENDENCY_CYCLE');
    expect(codeOf(() => topoSortRevisions([rev('r-a', 0, ['r-a'])]))).toBe('DEPENDENCY_CYCLE');
  });

  it('rejects external deps unless an anchor satisfies them', () => {
    expect(codeOf(() => topoSortRevisions([rev('r-a', 0, ['r-x'])]))).toBe('INVALID_INPUT');
    expect(topoSortRevisions([rev('r-a', 0, ['r-x'])], { satisfiedRevisionIds: ['r-x'] })).toHaveLength(1);
  });

  it('rejects duplicate revisions', () => {
    expect(codeOf(() => topoSortRevisions([rev('r-a', 0), rev('r-a', 1)]))).toBe('INVALID_INPUT');
  });
});

describe('dependencyClosure', () => {
  const all = [rev('r-p', 0), rev('r-c', 1), rev('r-k', 2), rev('r-r1', 3, ['r-p', 'r-c']), rev('r-r2', 4, ['r-r1'])];

  it('includes transitive dependencies', () => {
    expect(dependencyClosure(['r-r2'], all).map((r) => r.revisionId)).toEqual(['r-p', 'r-c', 'r-r1', 'r-r2']);
  });

  it('stops at satisfied ids and rejects unknown ids', () => {
    expect(dependencyClosure(['r-r2'], all, { satisfiedRevisionIds: ['r-r1'] }).map((r) => r.revisionId)).toEqual(['r-r2']);
    expect(codeOf(() => dependencyClosure(['r-zzz'], all))).toBe('INVALID_INPUT');
  });
});

const planBase = {
  sessionId: 'ses-1',
  label: 'Full goal',
  baselineSha: sha('a'),
  expectedMainSha: sha('a'),
  taskSetDigest: dg('1'),
  harnessDigest: dg('2'),
  policyDigest: dg('3'),
  environmentDigest: dg('4'),
};

describe('buildCandidatePlan', () => {
  it('sorts members topologically and strips ordinals', () => {
    const plan = buildCandidatePlan({ ...planBase, members: [rev('r-k', 2), rev('r-p', 0), rev('r-c', 1)] });
    expect(plan.members.map((m) => m.revisionId)).toEqual(['r-p', 'r-c', 'r-k']);
    expect(plan.members[0]).not.toHaveProperty('ordinal');
  });

  it('accepts a repair on an anchor and rejects an anchor that is not a subset', () => {
    const anchorHead = sha('e');
    const members = [rev('r-p', 0), rev('r-c', 1), rev('r-k', 2), rev('r-r', 3, ['r-p', 'r-c'], anchorHead)];
    const anchor = { candidateId: 'cand-pc', headSha: anchorHead, includedRevisionIds: ['r-c', 'r-p'] };
    const plan = buildCandidatePlan({ ...planBase, members, anchor });
    expect(plan.anchor?.includedRevisionIds).toEqual(['r-c', 'r-p']);
    expect(plan.members.map((m) => m.revisionId)).toEqual(['r-p', 'r-c', 'r-k', 'r-r']);

    expect(
      codeOf(() => buildCandidatePlan({ ...planBase, members, anchor: { ...anchor, includedRevisionIds: ['r-p', 'r-zz'] } })),
    ).toBe('INVALID_INPUT');
  });

  it('rejects a member on a foreign base', () => {
    expect(codeOf(() => buildCandidatePlan({ ...planBase, members: [rev('r-p', 0, [], sha('f'))] }))).toBe('INVALID_INPUT');
    // A repair base without an anchor is foreign too.
    expect(codeOf(() => buildCandidatePlan({ ...planBase, members: [rev('r-p', 0), rev('r-r', 1, ['r-p'], sha('e'))] }))).toBe(
      'INVALID_INPUT',
    );
  });

  it('rejects schema-invalid input as INVALID_INPUT', () => {
    expect(codeOf(() => buildCandidatePlan({ ...planBase, sessionId: 'BAD ID', members: [] }))).toBe('INVALID_INPUT');
  });

  it('rejects cycles', () => {
    expect(codeOf(() => buildCandidatePlan({ ...planBase, members: [rev('r-a', 0, ['r-b']), rev('r-b', 1, ['r-a'])] }))).toBe(
      'DEPENDENCY_CYCLE',
    );
  });
});

describe('planKey', () => {
  it('ignores member input order and label, but not membership', async () => {
    const a = buildCandidatePlan({ ...planBase, members: [rev('r-p', 0), rev('r-c', 1)] });
    const b = buildCandidatePlan({ ...planBase, label: 'Other', members: [rev('r-c', 1), rev('r-p', 0)] });
    const c = buildCandidatePlan({ ...planBase, members: [rev('r-p', 0)] });
    expect(await planKey(a)).toBe(await planKey(b));
    expect(await planKey(a)).not.toBe(await planKey(c));
  });
});

describe('selectInitialCandidates', () => {
  const standalone = [
    { proposalId: 'checkout', revisionId: 'r-k', ordinal: 2 },
    { proposalId: 'pricing', revisionId: 'r-p', ordinal: 0 },
    { proposalId: 'caching', revisionId: 'r-c', ordinal: 1 },
  ];
  const labels = new Map([
    ['pricing', 'Pricing'],
    ['caching', 'Caching'],
    ['checkout', 'Checkout'],
  ]);
  const interactions = detectInteractions({
    baselineFacts: BASELINE_FACTS,
    proposals: [
      { proposalId: 'pricing', ordinal: 0, intent: pricingIntent, intentDigest: dg('0') },
      { proposalId: 'caching', ordinal: 1, intent: cachingIntent, intentDigest: dg('1') },
      { proposalId: 'checkout', ordinal: 2, intent: checkoutIntent, intentDigest: dg('2') },
    ],
  });

  it('picks baseline, standalones, the pricing+caching pair, and the full goal', () => {
    const result = selectInitialCandidates({ standalone, interactions, labels, maxCandidates: 10 });
    expect(result.map((c) => [c.kind, c.label, c.revisionIds])).toEqual([
      ['baseline', 'Baseline', []],
      ['standalone', 'Pricing', ['r-p']],
      ['standalone', 'Caching', ['r-c']],
      ['standalone', 'Checkout', ['r-k']],
      ['pair', 'Pricing + Caching', ['r-p', 'r-c']],
      ['full', 'Pricing + Caching + Checkout', ['r-p', 'r-c', 'r-k']],
    ]);
  });

  it('picks the most-interacting pair over ordinal order', () => {
    const result = selectInitialCandidates({
      standalone,
      interactions: [{ kind: 'assumption', state: 'predicted', leftProposalId: 'checkout', rightProposalId: 'caching' }],
      labels,
      maxCandidates: 10,
    });
    expect(result.find((c) => c.kind === 'pair')?.proposalIds).toEqual(['caching', 'checkout']);
  });

  it('falls back to the first two by ordinal with no interactions', () => {
    const result = selectInitialCandidates({ standalone, interactions: [], labels, maxCandidates: 10 });
    expect(result.find((c) => c.kind === 'pair')?.proposalIds).toEqual(['pricing', 'caching']);
  });

  it('caps the list but always keeps the full combination', () => {
    const result = selectInitialCandidates({ standalone, interactions, labels, maxCandidates: 3 });
    expect(result.map((c) => c.label)).toEqual(['Baseline', 'Pricing', 'Pricing + Caching + Checkout']);
    expect(selectInitialCandidates({ standalone, interactions, labels, maxCandidates: 1 }).map((c) => c.kind)).toEqual(['full']);
  });

  it('dedupes when a pair or standalone would equal the full goal', () => {
    const two = selectInitialCandidates({ standalone: standalone.slice(1), interactions, labels, maxCandidates: 10 });
    expect(two.map((c) => c.kind)).toEqual(['baseline', 'standalone', 'standalone', 'full']);
    const one = selectInitialCandidates({ standalone: standalone.slice(1, 2), interactions, labels, maxCandidates: 10 });
    expect(one.map((c) => c.kind)).toEqual(['baseline', 'full']);
  });
});

describe('capabilitiesOf', () => {
  const tasks: TaskSpec[] = [
    ...STOREFRONT_TASKS.map((t) => ({ ...t, baselineSha: sha('a') })),
    {
      ...STOREFRONT_TASKS[1]!,
      id: 'task-repair',
      role: 'repair',
      capabilityIds: ['membership-pricing'],
      baselineSha: sha('e'),
    },
  ];
  const revisionToTask = new Map([
    ['r-p', 'task-pricing'],
    ['r-c', 'task-caching'],
    ['r-k', 'task-checkout'],
    ['r-r', 'task-repair'],
  ]);

  it('unions feature task capabilities; repairs add none', () => {
    expect(capabilitiesOf(['r-c', 'r-r'], revisionToTask, tasks)).toEqual(new Set(['quote-cache']));
    expect(capabilitiesOf(['r-p', 'r-c', 'r-k', 'r-r'], revisionToTask, tasks)).toEqual(new Set(ALL_CAPABILITIES));
  });

  it('rejects unmapped revisions', () => {
    expect(codeOf(() => capabilitiesOf(['r-x'], revisionToTask, tasks))).toBe('INVALID_INPUT');
  });
});
