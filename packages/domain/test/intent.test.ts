import { describe, expect, it } from 'vitest';
import {
  type Assumption,
  BASELINE_FACTS,
  ChangeIntent,
  detectInteractions,
  effectiveFacts,
  evaluateAssumption,
  PredictedInteraction,
  type ProposalIntent,
} from '../src/index.ts';
import { cachingIntent, checkoutIntent, dg, intent, pricingIntent, repairedCachingIntent } from './fixtures.ts';

const rationale = 'r';
const eq = (expected: Assumption['expected']): Assumption => ({ key: 'a.b', operator: 'eq', expected, rationale }) as Assumption;
const subset = (expected: string[]): Assumption => ({ key: 'a.b', operator: 'subset_of', expected, rationale });
const contains = (expected: string): Assumption => ({ key: 'a.b', operator: 'contains', expected, rationale });

describe('evaluateAssumption', () => {
  it('eq is structural', () => {
    expect(evaluateAssumption(eq(['x', 'y']), ['x', 'y'])).toBe('holds');
    expect(evaluateAssumption(eq(['x', 'y']), ['y', 'x'])).toBe('violated');
    expect(evaluateAssumption(eq(1), 1)).toBe('holds');
    expect(evaluateAssumption(eq(1), '1')).toBe('violated');
    expect(evaluateAssumption(eq(null), null)).toBe('holds');
    expect(evaluateAssumption(eq(false), false)).toBe('holds');
  });

  it('subset_of checks actual ⊆ expected', () => {
    expect(evaluateAssumption(subset(['productId']), ['productId'])).toBe('holds');
    expect(evaluateAssumption(subset(['productId', 'tier']), [])).toBe('holds');
    expect(evaluateAssumption(subset(['productId']), ['productId', 'tier'])).toBe('violated');
    expect(evaluateAssumption(subset(['productId']), 'productId')).toBe('unknown');
  });

  it('contains checks membership in an actual list', () => {
    expect(evaluateAssumption(contains('x'), ['x', 'y'])).toBe('holds');
    expect(evaluateAssumption(contains('z'), ['x', 'y'])).toBe('violated');
    expect(evaluateAssumption(contains('x'), 'x')).toBe('unknown');
    expect(evaluateAssumption(contains('x'), null)).toBe('unknown');
  });

  it('missing facts are unknown for every operator', () => {
    expect(evaluateAssumption(eq(1), undefined)).toBe('unknown');
    expect(evaluateAssumption(subset([]), undefined)).toBe('unknown');
    expect(evaluateAssumption(contains('x'), undefined)).toBe('unknown');
  });

  it('schema rejects invalid operator/value combinations', () => {
    const bad = intent();
    const parsed = ChangeIntent.safeParse({
      ...bad,
      assumptions: [{ key: 'a.b', operator: 'subset_of', expected: 'x', rationale }],
    });
    expect(parsed.success).toBe(false);
  });
});

function p(proposalId: string, ordinal: number, i: ChangeIntent, digestChar = String(ordinal)): ProposalIntent {
  return { proposalId, ordinal, intent: i, intentDigest: dg(digestChar) };
}

describe('detectInteractions: storefront', () => {
  it('pricing dimension change violates the product-only cache assumption', () => {
    const result = detectInteractions({
      baselineFacts: BASELINE_FACTS,
      proposals: [p('pricing', 0, pricingIntent), p('caching', 1, cachingIntent), p('checkout', 2, checkoutIntent)],
    });
    expect(result).toHaveLength(1);
    const [it0] = result;
    expect(PredictedInteraction.parse(it0)).toEqual(it0);
    expect(it0).toMatchObject({
      kind: 'assumption',
      state: 'predicted',
      contractKey: 'unit-price.dimensions',
      leftProposalId: 'pricing',
      rightProposalId: 'caching',
      leftIntentDigest: dg('0'),
      rightIntentDigest: dg('1'),
    });
    expect(it0!.explanation).toBe(
      'pricing changes unit-price.dimensions to [productId, membershipTier]; caching assumes subset_of [productId].',
    );
    expect(it0!.dedupeKey).toBe(`assumption|unit-price.dimensions|pricing:${dg('0')}>caching:${dg('1')}`);
  });

  it('repaired caching intent clears the interaction', () => {
    const result = detectInteractions({
      baselineFacts: BASELINE_FACTS,
      proposals: [p('pricing', 0, pricingIntent), p('caching', 1, repairedCachingIntent)],
    });
    expect(result).toEqual([]);
  });

  it('is independent of input order', () => {
    const proposals = [p('pricing', 0, pricingIntent), p('caching', 1, cachingIntent), p('checkout', 2, checkoutIntent)];
    const a = detectInteractions({ baselineFacts: BASELINE_FACTS, proposals });
    const b = detectInteractions({ baselineFacts: BASELINE_FACTS, proposals: [...proposals].reverse() });
    expect(b).toEqual(a);
  });

  it('carries revision ids when given', () => {
    const [r] = detectInteractions({
      baselineFacts: BASELINE_FACTS,
      proposals: [
        { ...p('pricing', 0, pricingIntent), revisionId: 'rev-pricing' },
        { ...p('caching', 1, cachingIntent), revisionId: 'rev-caching' },
      ],
    });
    expect(r).toMatchObject({ leftRevisionId: 'rev-pricing', rightRevisionId: 'rev-caching' });
  });
});

describe('detectInteractions: generic rules', () => {
  const change = (key: string, before: ChangeIntent['contractChanges'][number]['before'], after: ChangeIntent['contractChanges'][number]['after']) =>
    ({ key, before, after, explanation: 'x' });

  it('works for arbitrary keys and operators', () => {
    const baselineFacts = { 'ledger.flags': ['a', 'b'], 'ledger.mode': 'strict' };
    const writer = intent({ contractChanges: [change('ledger.flags', ['a', 'b'], ['b']), change('ledger.mode', 'strict', 'lax')] });
    const reader = intent({
      assumptions: [
        { key: 'ledger.flags', operator: 'contains', expected: 'a', rationale },
        { key: 'ledger.mode', operator: 'eq', expected: 'strict', rationale },
      ],
    });
    const result = detectInteractions({ baselineFacts, proposals: [p('alpha', 0, writer), p('beta', 1, reader)] });
    expect(result.map((r) => [r.kind, r.state, r.contractKey])).toEqual([
      ['assumption', 'predicted', 'ledger.flags'],
      ['assumption', 'predicted', 'ledger.mode'],
    ]);
  });

  it('unevaluable assumption yields unknown, not confidence', () => {
    const writer = intent({ contractChanges: [change('x.y', ['a'], 'scalar')] });
    const reader = intent({ assumptions: [{ key: 'x.y', operator: 'subset_of', expected: ['a'], rationale }] });
    const [r] = detectInteractions({ baselineFacts: { 'x.y': ['a'] }, proposals: [p('w', 0, writer), p('r', 1, reader)] });
    expect(r).toMatchObject({ kind: 'assumption', state: 'unknown', contractKey: 'x.y' });
  });

  it('a contested before-value yields unknown even when the assumption holds', () => {
    const writer = intent({ contractChanges: [change('x.y', 'old', 'new')] });
    const reader = intent({ assumptions: [{ key: 'x.y', operator: 'eq', expected: 'new', rationale }] });
    const [r] = detectInteractions({ baselineFacts: { 'x.y': 'actual' }, proposals: [p('w', 0, writer), p('r', 1, reader)] });
    expect(r).toMatchObject({ state: 'unknown' });
    expect(r!.explanation).toContain('contested');
  });

  it('records shared writes with different values and never resolves them by order', () => {
    const a = intent({ contractChanges: [change('quote.response-version', 1, 2)] });
    const b = intent({ contractChanges: [change('quote.response-version', 1, 3)] });
    const result = detectInteractions({ baselineFacts: BASELINE_FACTS, proposals: [p('b', 1, b), p('a', 0, a)] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'shared_write', state: 'predicted', leftProposalId: 'a', rightProposalId: 'b' });
    const facts = effectiveFacts(BASELINE_FACTS, [
      { proposalId: 'a', intent: a },
      { proposalId: 'b', intent: b },
    ]);
    const fact = facts.find((f) => f.key === 'quote.response-version')!;
    expect(fact.contested).toBe(true);
    expect(fact.value).toBeUndefined();
  });

  it('identical writes are not a shared-write interaction', () => {
    const a = intent({ contractChanges: [change('quote.response-version', 1, 2)] });
    expect(detectInteractions({ baselineFacts: BASELINE_FACTS, proposals: [p('a', 0, a), p('b', 1, a, 'x')] })).toEqual([]);
  });

  it('reports file overlap as a separate signal', () => {
    const a = intent({ affectedPaths: ['src/shared.ts', 'src/a.ts'] });
    const b = intent({ affectedPaths: ['src/b.ts', 'src/shared.ts'] });
    const result = detectInteractions({ baselineFacts: {}, proposals: [p('a', 0, a), p('b', 1, b)] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'file_overlap', leftProposalId: 'a', rightProposalId: 'b' });
    expect(result[0]!.contractKey).toBeUndefined();
    expect(result[0]!.explanation).toContain('src/shared.ts');
  });

  it('orders output by kind, then key', () => {
    const a = intent({ affectedPaths: ['f.ts'], contractChanges: [change('k.v', 1, 2)] });
    const b = intent({ affectedPaths: ['f.ts'], contractChanges: [change('k.v', 1, 3)], assumptions: [{ key: 'k.v', operator: 'eq', expected: 1, rationale }] });
    const kinds = detectInteractions({ baselineFacts: { 'k.v': 1 }, proposals: [p('a', 0, a), p('b', 1, b)] }).map((r) => r.kind);
    expect(kinds).toEqual(['assumption', 'shared_write', 'file_overlap']);
  });
});

describe('effectiveFacts', () => {
  it('applies a single writer and leaves untouched keys at baseline', () => {
    const facts = effectiveFacts(BASELINE_FACTS, [{ proposalId: 'pricing', intent: pricingIntent }]);
    const dims = facts.find((f) => f.key === 'unit-price.dimensions')!;
    expect(dims).toMatchObject({ value: ['productId', 'membershipTier'], contested: false });
    expect(facts.find((f) => f.key === 'unit-price.currency')).toMatchObject({ value: 'USD', contested: false, writers: [] });
    expect(facts.map((f) => f.key)).toEqual([...Object.keys(BASELINE_FACTS)].sort());
  });

  it('marks a key contested when before disagrees with baseline', () => {
    const i = intent({ contractChanges: [{ key: 'unit-price.currency', before: 'EUR', after: 'GBP', explanation: 'x' }] });
    const fact = effectiveFacts(BASELINE_FACTS, [{ proposalId: 'x', intent: i }]).find((f) => f.key === 'unit-price.currency')!;
    expect(fact.contested).toBe(true);
    expect(fact.value).toBe('GBP');
  });
});
