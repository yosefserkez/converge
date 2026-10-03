import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_TOKEN, T0, catFile, createFixture, isAncestor, revParse, seed, type Fixture } from './git-helpers.ts';

let fx: Fixture;
beforeEach(() => {
  fx = createFixture();
});
afterEach(() => {
  expect(fx.leftovers()).toEqual([]);
  fx.cleanup();
});

type Repo = { dir: string; url: string };
type Head = Repo & { sha: string };

async function fork(name: string, baseSha: string, baseRemote: string, files: Record<string, string>): Promise<Head> {
  const repo = fx.bare(name);
  const res = await fx.broker.commitEdits({
    remote: repo.url,
    token: FAKE_TOKEN,
    baseSha,
    branch: 'main',
    files: Object.entries(files).map(([path, utf8]) => ({ path, utf8 })),
    editablePaths: ['src/**'],
    protectedPaths: ['src/server.ts'],
    message: `proposal ${name}`,
    timestamp: T0 + 10,
    sourceRemote: baseRemote,
    sourceToken: FAKE_TOKEN,
  });
  return { ...repo, sha: res.headSha };
}

const member = (h: Head, label: string) => ({ remote: h.url, token: FAKE_TOKEN, sha: h.sha, label });

describe('assemble', { timeout: 30_000 }, () => {
  it('merges two independent forks onto the baseline', async () => {
    const base = await seed(fx);
    const a = await fork('fork-a', base.sha, base.url, { 'src/pricing/compute-unit-price.ts': 'A\n' });
    const b = await fork('fork-b', base.sha, base.url, { 'src/pricing/quote-cache.ts': 'B\n' });
    const cand = fx.bare('cand-ab');
    const input = {
      target: { remote: cand.url, token: FAKE_TOKEN, branch: 'main' },
      start: { remote: base.url, token: FAKE_TOKEN, sha: base.sha },
      merges: [member(a, 'pricing'), member(b, 'caching')],
      message: 'Candidate A+B',
      timestamp: T0 + 100,
    };
    const res = await fx.broker.assemble(input);
    if (res.status !== 'merged') throw new Error('expected merged');
    expect(res.steps.map((s) => s.label)).toEqual(['pricing', 'caching']);
    expect(res.alreadyIncluded).toEqual([]);
    expect(res.parents).toEqual([res.steps[0]!.commitSha, b.sha]);
    expect(res.steps[0]!.parents).toEqual([base.sha, a.sha]);
    expect(revParse(cand.dir, 'refs/heads/main')).toBe(res.headSha);
    expect(catFile(cand.dir, res.headSha, 'src/pricing/compute-unit-price.ts')).toBe('A\n');
    expect(catFile(cand.dir, res.headSha, 'src/pricing/quote-cache.ts')).toBe('B\n');
    expect(catFile(cand.dir, `${res.headSha}`, 'README.md')).toBe('# Storefront\n');

    const retry = await fx.broker.assemble(input);
    expect(retry).toMatchObject({ status: 'merged', headSha: res.headSha, pushed: false });
  });

  it('returns text_conflict with the conflicted paths and leaves the target untouched', async () => {
    const base = await seed(fx);
    const a = await fork('fork-a', base.sha, base.url, {
      'src/ui/CheckoutSummary.tsx': 'line1\nA-line2\nline3\n',
      'src/pricing/compute-unit-price.ts': 'A\n',
    });
    const b = await fork('fork-b', base.sha, base.url, { 'src/ui/CheckoutSummary.tsx': 'line1\nB-line2\nline3\n' });
    const cand = fx.bare('cand-conflict');
    const res = await fx.broker.assemble({
      target: { remote: cand.url, token: FAKE_TOKEN, branch: 'main' },
      start: { remote: base.url, token: FAKE_TOKEN, sha: base.sha },
      merges: [member(a, 'pricing'), member(b, 'checkout')],
      message: 'Candidate',
      timestamp: T0 + 100,
    });
    expect(res).toEqual({
      status: 'text_conflict',
      atMerge: 'checkout',
      conflictedPaths: ['src/ui/CheckoutSummary.tsx'],
      alreadyIncluded: [],
    });
    expect(() => revParse(cand.dir, 'refs/heads/main')).toThrow();
  });

  it('reuses a failed candidate as an anchor for an additive repair', async () => {
    const base = await seed(fx);
    const a = await fork('fork-a', base.sha, base.url, { 'src/pricing/compute-unit-price.ts': 'A\n' });
    const b = await fork('fork-b', base.sha, base.url, { 'src/pricing/quote-cache.ts': 'B\n' });
    const c = await fork('fork-c', base.sha, base.url, { 'src/ui/CheckoutSummary.tsx': 'line1\nC\nline3\n' });

    const anchorRepo = fx.bare('cand-ab');
    const anchor = await fx.broker.assemble({
      target: { remote: anchorRepo.url, token: FAKE_TOKEN, branch: 'main' },
      start: { remote: base.url, token: FAKE_TOKEN, sha: base.sha },
      merges: [member(a, 'A'), member(b, 'B')],
      message: 'Candidate A+B',
      timestamp: T0 + 100,
    });
    if (anchor.status !== 'merged') throw new Error('expected merged');

    // Repair R is written on top of the failed A+B head, in its own fork.
    const r = await fork('fork-r', anchor.headSha, anchorRepo.url, {
      'src/pricing/quote-cache.ts': 'B + repaired key\n',
    });
    expect(revParse(r.dir, `${r.sha}^`)).toBe(anchor.headSha);

    const finalRepo = fx.bare('cand-final');
    const final = await fx.broker.assemble({
      target: { remote: finalRepo.url, token: FAKE_TOKEN, branch: 'main' },
      start: { remote: anchorRepo.url, token: FAKE_TOKEN, sha: anchor.headSha },
      merges: [member(a, 'A'), member(b, 'B'), member(c, 'C'), member(r, 'R')],
      message: 'Candidate A+B+C+R',
      timestamp: T0 + 200,
    });
    if (final.status !== 'merged') throw new Error(`expected merged, got ${JSON.stringify(final)}`);
    expect(final.alreadyIncluded).toEqual(['A', 'B']);
    expect(final.steps.map((s) => s.label)).toEqual(['C', 'R']);
    expect(final.startSha).toBe(anchor.headSha);
    expect(final.steps[0]!.parents[0]).toBe(anchor.headSha);
    expect(isAncestor(finalRepo.dir, anchor.headSha, final.headSha)).toBe(true);
    expect(catFile(finalRepo.dir, final.headSha, 'src/pricing/quote-cache.ts')).toBe('B + repaired key\n');
    expect(catFile(finalRepo.dir, final.headSha, 'src/ui/CheckoutSummary.tsx')).toBe('line1\nC\nline3\n');
    expect(catFile(finalRepo.dir, final.headSha, 'src/pricing/compute-unit-price.ts')).toBe('A\n');
  });

  it('rejects duplicate merge labels', async () => {
    const base = await seed(fx);
    const cand = fx.bare('cand');
    await expect(
      fx.broker.assemble({
        target: { remote: cand.url, token: FAKE_TOKEN, branch: 'main' },
        start: { remote: base.url, token: FAKE_TOKEN, sha: base.sha },
        merges: [member(base, 'X'), member(base, 'X')],
        message: 'm',
        timestamp: T0,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
