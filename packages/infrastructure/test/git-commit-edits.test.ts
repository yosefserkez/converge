import { PROTECTED_PATHS } from '@converge/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommitEditsInput } from '../src/git/index.ts';
import { FAKE_TOKEN, T0, catFile, commitRaw, createFixture, git, revParse, seed, type Fixture } from './git-helpers.ts';

let fx: Fixture;
beforeEach(() => {
  fx = createFixture();
});
afterEach(() => {
  expect(fx.leftovers()).toEqual([]);
  fx.cleanup();
});

const EDITABLE = ['src/pricing/compute-unit-price.ts', 'tests/pricing/**'];

async function setup(): Promise<{ base: { dir: string; url: string; sha: string }; input: CommitEditsInput }> {
  const base = await seed(fx);
  return {
    base,
    input: {
      remote: base.url,
      token: FAKE_TOKEN,
      baseSha: base.sha,
      branch: 'proposal/pricing',
      files: [
        { path: 'src/pricing/compute-unit-price.ts', utf8: 'export const price = (c: number) => Math.round(c * 0.8);\n' },
        { path: 'tests/pricing/member.test.ts', utf8: 'test("member", () => {});\n' },
      ],
      editablePaths: EDITABLE,
      protectedPaths: [...PROTECTED_PATHS],
      message: 'Pricing: member discount',
      timestamp: T0 + 60,
    },
  };
}

describe('commitEdits', { timeout: 30_000 }, () => {
  it('commits validated edits on top of baseSha and verifies the remote branch', async () => {
    const { base, input } = await setup();
    const res = await fx.broker.commitEdits(input);
    expect(res.pushed).toBe(true);
    expect(revParse(base.dir, 'refs/heads/proposal/pricing')).toBe(res.headSha);
    expect(revParse(base.dir, `${res.headSha}^`)).toBe(base.sha);
    expect(revParse(base.dir, `${res.headSha}^{tree}`)).toBe(res.treeSha);
    expect(res.changedPaths.sort()).toEqual(['src/pricing/compute-unit-price.ts', 'tests/pricing/member.test.ts']);
    expect(res.diff).toContain('+export const price = (c: number) => Math.round(c * 0.8);');
    expect(res.diffTruncated).toBe(false);
    expect(catFile(base.dir, res.headSha, 'src/server.ts')).toBe('export const server = 1;\n');
    const meta = git(base.dir, ['log', '-1', '--format=%an <%ae> %at|%cn <%ce> %ct', res.headSha], { GIT_DIR: base.dir });
    expect(meta.trim()).toBe(`Converge Broker <broker@converge.invalid> ${T0 + 60}|Converge Broker <broker@converge.invalid> ${T0 + 60}`);
  });

  it('is deterministic: a retry yields the same SHA without pushing again', async () => {
    const { input } = await setup();
    const first = await fx.broker.commitEdits(input);
    const retry = await fx.broker.commitEdits(input);
    expect(retry.headSha).toBe(first.headSha);
    expect(retry.pushed).toBe(false);
  });

  it('supports deletes and preserves the existing file mode', async () => {
    const base = fx.bare('modes');
    const sha = commitRaw(base.dir, 'main', [
      { path: 'bin/run.sh', mode: '100755', content: 'echo hi\n' },
      { path: 'bin/old.sh', content: 'old\n' },
    ]);
    const res = await fx.broker.commitEdits({
      remote: base.url,
      token: FAKE_TOKEN,
      baseSha: sha,
      branch: 'main',
      files: [
        { path: 'bin/run.sh', utf8: 'echo bye\n' },
        { path: 'bin/old.sh', utf8: null },
      ],
      editablePaths: ['bin/**'],
      protectedPaths: [],
      message: 'edit',
      timestamp: T0,
    });
    expect(res.changedPaths.sort()).toEqual(['bin/old.sh', 'bin/run.sh']);
    expect(res.diff).toContain('deleted file mode 100644');
    expect(res.diff).not.toContain('new mode');
  });

  it('rejects protected paths with PROTECTED_PATH', async () => {
    const { base, input } = await setup();
    await expect(
      fx.broker.commitEdits({ ...input, editablePaths: ['src/**'], files: [{ path: 'src/server.ts', utf8: 'pwned' }] }),
    ).rejects.toMatchObject({ code: 'PROTECTED_PATH' });
    await expect(
      fx.broker.commitEdits({ ...input, editablePaths: ['public/**'], files: [{ path: 'public/index.html', utf8: 'x' }] }),
    ).rejects.toMatchObject({ code: 'PROTECTED_PATH' });
    expect(() => revParse(base.dir, 'refs/heads/proposal/pricing')).toThrow();
  });

  it('rejects out-of-scope paths with OUT_OF_SCOPE_EDIT', async () => {
    const { input } = await setup();
    await expect(
      fx.broker.commitEdits({ ...input, files: [{ path: 'src/pricing/quote-cache.ts', utf8: 'x' }] }),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE_EDIT' });
    // `tests/pricing/**` covers the directory contents, not a sibling with the same prefix.
    await expect(
      fx.broker.commitEdits({ ...input, files: [{ path: 'tests/pricing-evil.ts', utf8: 'x' }] }),
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE_EDIT' });
  });

  it.each([
    '../outside.ts',
    'tests/pricing/../../src/server.ts',
    '/etc/passwd',
    'tests/pricing/.git/config',
    'tests/pricing/.GIT/hooks/pre-commit',
    'tests\\pricing\\x.ts',
    'tests/pricing//x.ts',
  ])('rejects traversal or unsafe path %s', async (badPath) => {
    const { input } = await setup();
    await expect(fx.broker.commitEdits({ ...input, files: [{ path: badPath, utf8: 'x' }] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('rejects a no-op edit set', async () => {
    const { input } = await setup();
    await expect(
      fx.broker.commitEdits({
        ...input,
        files: [{ path: 'src/pricing/compute-unit-price.ts', utf8: 'export const price = (c: number) => c;\n' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('no change') });
  });

  it('refuses to overwrite a branch that points elsewhere', async () => {
    const { base, input } = await setup();
    const other = commitRaw(base.dir, 'proposal/pricing', [{ path: 'x.txt', content: 'unrelated' }]);
    await expect(fx.broker.commitEdits(input)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(revParse(base.dir, 'refs/heads/proposal/pricing')).toBe(other);
  });

  it('fast-forwards a fork branch that still points at the base', async () => {
    const { base, input } = await setup();
    const res = await fx.broker.commitEdits({ ...input, branch: 'main' });
    expect(revParse(base.dir, 'refs/heads/main')).toBe(res.headSha);
  });

  it('fetches baseSha from sourceRemote when the fork lacks it', async () => {
    const { base, input } = await setup();
    const fork = fx.bare('fork-empty');
    const res = await fx.broker.commitEdits({
      ...input,
      remote: fork.url,
      sourceRemote: base.url,
      sourceToken: 'cfart_OTHER_SOURCE_TOKEN_123456',
    });
    expect(revParse(fork.dir, 'refs/heads/proposal/pricing')).toBe(res.headSha);
    expect(revParse(fork.dir, `${res.headSha}^`)).toBe(base.sha);
  });

  it('truncates very large diffs and labels them', async () => {
    const { input } = await setup();
    const big = Array.from({ length: 6000 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    const res = await fx.broker.commitEdits({ ...input, files: [{ path: 'tests/pricing/big.ts', utf8: big }] });
    expect(res.diffTruncated).toBe(true);
    expect(res.diff).toMatch(/\[diff truncated at \d+ bytes\]\n$/);
    expect(res.diff.length).toBeLessThan(70 * 1024);
  });
});
