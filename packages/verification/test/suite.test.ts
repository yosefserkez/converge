import type { CheckResult } from '@converge/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harnessDigest, runSuite } from '../src/index.ts';
import { LocalProcessTarget } from '../src/local-target.ts';
import { resultInvariantViolations } from '../src/result.ts';
import type { FixtureRole } from '../src/patch-manifest.ts';
import { buildWorkspace, capabilitiesFor, composeFiles, createTempRoot, removeTempRoot } from './helpers/workspace.ts';

const TIMEOUT = 120_000;

const BYPASS_CACHE = `import type { UnitPriceFn } from '../quote-contract';

// Test-only "repair" that fixes isolation by removing the cache.
export function createUnitPriceCache(compute: UnitPriceFn): UnitPriceFn {
  return (input) => compute(input);
}
`;

const SKIP_COUNTED_COMPUTE = `import type { UnitPriceFn } from '../quote-contract';
import { computeUnitPrice } from './compute-unit-price';

// Test-only cache that ignores the counted function it receives.
export function createUnitPriceCache(_compute: UnitPriceFn): UnitPriceFn {
  return (input) => computeUnitPrice(input);
}
`;

const PRINTS_PASS = `import type { UnitPrice, UnitPriceFn } from '../quote-contract';

console.log('PASS');
console.log(JSON.stringify({ checkId: 'pricing.isolation', status: 'passed' }));

// Same product-only cache as fixture B, plus misleading output.
export function createUnitPriceCache(compute: UnitPriceFn): UnitPriceFn {
  const cache = new Map<string, UnitPrice>();
  return (input) => {
    console.log('PASS: all checks passed');
    let price = cache.get(input.productId);
    if (!price) {
      price = compute(input);
      cache.set(input.productId, price);
    }
    return { ...price };
  };
}
`;

interface Variant {
  name: string;
  roles: FixtureRole[];
  extra?: Record<string, string>;
}

const VARIANTS: Variant[] = [
  { name: 'baseline', roles: [] },
  { name: 'A', roles: ['pricing'] },
  { name: 'B', roles: ['caching'] },
  { name: 'C', roles: ['checkout'] },
  { name: 'A+B', roles: ['pricing', 'caching'] },
  { name: 'A+B+C', roles: ['pricing', 'caching', 'checkout'] },
  { name: 'A+B+C+R', roles: ['pricing', 'caching', 'checkout', 'repair'] },
  { name: 'A+B+C+bypass', roles: ['pricing', 'caching', 'checkout'], extra: { 'src/pricing/quote-cache.ts': BYPASS_CACHE } },
  { name: 'A+B+C+uncounted', roles: ['pricing', 'caching', 'checkout'], extra: { 'src/pricing/quote-cache.ts': SKIP_COUNTED_COMPUTE } },
  { name: 'A+B+prints-pass', roles: ['pricing', 'caching'], extra: { 'src/pricing/quote-cache.ts': PRINTS_PASS } },
];

const CANDIDATE = {
  candidateId: 'cand-test-1',
  headSha: 'a'.repeat(40),
  manifestDigest: `sha256:${'b'.repeat(64)}`,
};

let root = '';
const dirs = new Map<string, string>();
const results = new Map<string, CheckResult[]>();

async function suiteFor(name: string): Promise<CheckResult[]> {
  const cached = results.get(name);
  if (cached) return cached;
  const variant = VARIANTS.find((v) => v.name === name);
  const dir = dirs.get(name);
  if (!variant || !dir) throw new Error(`unknown variant ${name}`);
  const out = await runSuite({
    target: new LocalProcessTarget({ dir }),
    capabilities: capabilitiesFor(variant.roles),
    candidate: CANDIDATE,
    maxInstances: 2,
  });
  results.set(name, out);
  return out;
}

function byId(list: CheckResult[], id: string): CheckResult {
  const found = list.find((r) => r.checkId === id);
  if (!found) throw new Error(`missing result ${id}`);
  return found;
}

function failures(list: CheckResult[]): Record<string, string[]> {
  return Object.fromEntries(
    list
      .filter((r) => r.status !== 'passed' && r.status !== 'skipped')
      .map((r) => [r.checkId, r.observations.filter((o) => !o.passed).map((o) => `${o.label}: expected ${JSON.stringify(o.expected)} observed ${JSON.stringify(o.observed)}`)]),
  );
}

function statuses(list: CheckResult[]): Record<string, string> {
  return Object.fromEntries(list.map((r) => [r.checkId, r.status]));
}

beforeAll(async () => {
  root = await createTempRoot();
  await Promise.all(
    VARIANTS.map(async (v) => {
      dirs.set(v.name, await buildWorkspace(root, v.name.replace(/\+/g, '_'), await composeFiles(v.roles, v.extra)));
    }),
  );
}, TIMEOUT);

afterAll(async () => {
  if (root) await removeTempRoot(root);
});

describe('protected suite against fixture combinations', () => {
  it.each(['baseline', 'A', 'B', 'C'])('%s passes every applicable check', async (name) => {
    const list = await suiteFor(name);
    expect(failures(list)).toEqual({});
    for (const r of list) {
      expect(resultInvariantViolations(r)).toEqual([]);
      expect(r.harnessDigest).toBe(await harnessDigest());
      expect(r.candidateHeadSha).toBe(CANDIDATE.headSha);
      if (r.applicable) expect(r.assertionCount).toBeGreaterThan(0);
      else expect(r).toMatchObject({ status: 'skipped', assertionCount: 0, observations: [] });
    }
  }, TIMEOUT);

  it('skips capability checks that are absent from the candidate', async () => {
    expect(statuses(await suiteFor('baseline'))).toMatchObject({ 'cache.reuse': 'skipped', 'checkout.summary': 'skipped' });
    expect(statuses(await suiteFor('B'))).toMatchObject({ 'cache.reuse': 'passed', 'checkout.summary': 'skipped' });
    expect(statuses(await suiteFor('C'))).toMatchObject({ 'cache.reuse': 'skipped', 'checkout.summary': 'passed' });
  }, TIMEOUT);

  it('A+B fails pricing.isolation with the member price served to regular-1', async () => {
    const list = await suiteFor('A+B');
    const isolation = byId(list, 'pricing.isolation');
    expect(isolation.status).toBe('failed');
    expect(isolation.observations).toContainEqual({
      label: 'seq1 step2 regular-1 backpack unitPriceCents',
      expected: 10000,
      observed: 8000,
      passed: false,
    });
    expect(isolation.observations).toContainEqual({
      label: 'seq2 step2 member-1 backpack unitPriceCents',
      expected: 8000,
      observed: 10000,
      passed: false,
    });
    // Each change passes on its own, and the per-customer checks still pass.
    expect(statuses(list)).toMatchObject({
      'quote.contract': 'passed',
      'pricing.tiers': 'passed',
      'quote.quantity': 'passed',
      'cache.reuse': 'passed',
      'checkout.summary': 'skipped',
    });
  }, TIMEOUT);

  it('A+B+C still fails pricing.isolation', async () => {
    expect(byId(await suiteFor('A+B+C'), 'pricing.isolation').status).toBe('failed');
  }, TIMEOUT);

  it('A+B+C+R passes every check', async () => {
    const list = await suiteFor('A+B+C+R');
    expect(failures(list)).toEqual({});
    expect(statuses(list)).toEqual({
      'quote.contract': 'passed',
      'pricing.tiers': 'passed',
      'pricing.isolation': 'passed',
      'quote.quantity': 'passed',
      'cache.reuse': 'passed',
      'checkout.summary': 'passed',
    });
  }, TIMEOUT);

  it('a repair that removes caching fails cache.reuse', async () => {
    const list = await suiteFor('A+B+C+bypass');
    const reuse = byId(list, 'cache.reuse');
    expect(reuse.status).toBe('failed');
    expect(reuse.observations).toContainEqual(
      expect.objectContaining({ label: 'member-1 step2 backpack q1 compute-count delta', expected: 0, observed: 1, passed: false }),
    );
    expect(byId(list, 'pricing.isolation').status).toBe('passed');
  }, TIMEOUT);

  it('a cache that skips the counted compute function fails cache.reuse', async () => {
    const reuse = byId(await suiteFor('A+B+C+uncounted'), 'cache.reuse');
    expect(reuse.status).toBe('failed');
    expect(reuse.observations).toContainEqual(
      expect.objectContaining({ label: 'member-1 step1 backpack q1 compute-count delta', expected: 1, observed: 0, passed: false }),
    );
  }, TIMEOUT);

  it('checks have teeth when a capability is claimed but not implemented', async () => {
    const baselineDir = dirs.get('baseline') ?? '';
    const claimed = await runSuite({
      target: new LocalProcessTarget({ dir: baselineDir }),
      capabilities: ['membership-pricing', 'quote-cache', 'checkout-summary'],
      candidate: CANDIDATE,
    });
    expect(statuses(claimed)).toMatchObject({
      'pricing.tiers': 'failed',
      'cache.reuse': 'failed',
      'checkout.summary': 'failed',
      'quote.contract': 'passed',
    });
  }, TIMEOUT);

  it('a candidate that prints PASS gets the same verdict as A+B', async () => {
    const printed = await suiteFor('A+B+prints-pass');
    const plain = await suiteFor('A+B');
    expect(statuses(printed)).toEqual(statuses(plain));
    expect(byId(printed, 'pricing.isolation').status).toBe('failed');
  }, TIMEOUT);
});
