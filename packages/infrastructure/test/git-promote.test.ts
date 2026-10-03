import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_TOKEN, T0, commitRaw, createFixture, revParse, seed, type Fixture } from './git-helpers.ts';

let fx: Fixture;
beforeEach(() => {
  fx = createFixture();
});
afterEach(() => {
  expect(fx.leftovers()).toEqual([]);
  fx.cleanup();
});

async function candidate(base: { url: string; sha: string }, name: string, content: string): Promise<{ dir: string; url: string; sha: string }> {
  const repo = fx.bare(name);
  const res = await fx.broker.commitEdits({
    remote: repo.url,
    token: FAKE_TOKEN,
    baseSha: base.sha,
    branch: 'main',
    files: [{ path: 'src/pricing/compute-unit-price.ts', utf8: content }],
    editablePaths: ['src/pricing/**'],
    protectedPaths: [],
    message: `candidate ${name}`,
    timestamp: T0 + 50,
    sourceRemote: base.url,
    sourceToken: FAKE_TOKEN,
  });
  return { ...repo, sha: res.headSha };
}

const promoteInput = (canonical: { url: string }, source: { url: string }, candidateSha: string, expectedMainSha: string) => ({
  canonical: { remote: canonical.url, token: FAKE_TOKEN },
  source: { remote: source.url, token: FAKE_TOKEN },
  candidateSha,
  expectedMainSha,
});

describe('promote', () => {
  it('moves canonical main to exactly the candidate SHA', async () => {
    const base = await seed(fx);
    const cand = await candidate(base, 'cand', 'v2\n');
    const res = await fx.broker.promote(promoteInput(base, cand, cand.sha, base.sha));
    expect(res).toEqual({ state: 'succeeded', observedRemoteSha: cand.sha, reconciled: false, pushed: true });
    expect(revParse(base.dir, 'refs/heads/main')).toBe(cand.sha);
  });

  it('reports stale and leaves main untouched when someone else pushed', async () => {
    const base = await seed(fx);
    const cand = await candidate(base, 'cand', 'v2\n');
    const other = commitRaw(base.dir, 'main', [{ path: 'hotfix.txt', content: 'x' }], base.sha);
    const res = await fx.broker.promote(promoteInput(base, cand, cand.sha, base.sha));
    expect(res).toEqual({ state: 'stale', observedRemoteSha: other, reconciled: false, pushed: false });
    expect(revParse(base.dir, 'refs/heads/main')).toBe(other);
  });

  it('rejects a candidate that does not descend from expected main', async () => {
    const base = await seed(fx);
    const rogue = fx.bare('rogue');
    const unrelated = commitRaw(rogue.dir, 'main', [{ path: 'README.md', content: 'replaced history\n' }]);
    await expect(fx.broker.promote(promoteInput(base, rogue, unrelated, base.sha))).rejects.toMatchObject({
      code: 'NOT_PROMOTABLE',
    });
    expect(revParse(base.dir, 'refs/heads/main')).toBe(base.sha);
  });

  it('lets exactly one of two racing promotions win', async () => {
    const base = await seed(fx);
    const c1 = await candidate(base, 'cand-1', 'one\n');
    const c2 = await candidate(base, 'cand-2', 'two\n');
    const results = await Promise.all([
      fx.broker.promote(promoteInput(base, c1, c1.sha, base.sha)),
      fx.broker.promote(promoteInput(base, c2, c2.sha, base.sha)),
    ]);
    const winners = results.filter((r) => r.state === 'succeeded');
    const losers = results.filter((r) => r.state !== 'succeeded');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.state).toBe('stale');
    const main = revParse(base.dir, 'refs/heads/main');
    expect(main).toBe(winners[0]!.observedRemoteSha);
    expect([c1.sha, c2.sha]).toContain(main);
    expect(losers[0]!.observedRemoteSha).toBe(main);
  });

  it('reconciles a lost callback without pushing again', async () => {
    const base = await seed(fx);
    const cand = await candidate(base, 'cand', 'v2\n');
    await fx.broker.promote(promoteInput(base, cand, cand.sha, base.sha));
    const retry = await fx.broker.promote(promoteInput(base, cand, cand.sha, base.sha));
    expect(retry).toEqual({ state: 'succeeded', observedRemoteSha: cand.sha, reconciled: true, pushed: false });
    expect(revParse(base.dir, 'refs/heads/main')).toBe(cand.sha);
  });
});
