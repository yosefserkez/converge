import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_FILES, FAKE_TOKEN, T0, commitRaw, createFixture, revParse, seed, type Fixture } from './git-helpers.ts';

let fx: Fixture;
beforeEach(() => {
  fx = createFixture();
});
afterEach(() => {
  expect(fx.leftovers()).toEqual([]);
  fx.cleanup();
});

describe('seedBaseline', { timeout: 30_000 }, () => {
  it('pushes an initial commit and reseeding the same tree is idempotent', async () => {
    const repo = fx.bare('canonical');
    const input = { remote: repo.url, token: FAKE_TOKEN, files: BASE_FILES, message: 'Baseline', timestamp: T0 };
    const first = await fx.broker.seedBaseline(input);
    expect(first.created).toBe(true);
    expect(revParse(repo.dir, 'refs/heads/main')).toBe(first.headSha);
    expect(revParse(repo.dir, 'main^{tree}')).toBe(first.treeSha);

    const again = await fx.broker.seedBaseline({ ...input, timestamp: T0 + 999, message: 'different message' });
    expect(again).toEqual({ headSha: first.headSha, treeSha: first.treeSha, created: false });
  });

  it('produces the same SHA for the same inputs in different repos', async () => {
    const a = await seed(fx, 'a');
    const b = await seed(fx, 'b');
    expect(a.sha).toBe(b.sha);
  });

  it('rejects a reseed with a different tree', async () => {
    const repo = await seed(fx);
    await expect(
      fx.broker.seedBaseline({
        remote: repo.url,
        token: FAKE_TOKEN,
        files: [{ path: 'other.txt', utf8: 'x' }],
        message: 'Baseline',
        timestamp: T0,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(revParse(repo.dir, 'main')).toBe(repo.sha);
  });

  it('readHead returns the branch tip or null', async () => {
    const repo = await seed(fx);
    expect(await fx.broker.readHead({ remote: repo.url, token: FAKE_TOKEN, branch: 'main' })).toEqual({ sha: repo.sha });
    expect(await fx.broker.readHead({ remote: repo.url, token: FAKE_TOKEN, branch: 'nope' })).toEqual({ sha: null });
  });
});

describe('materialize', { timeout: 30_000 }, () => {
  it('returns every file at the exact commit with sha256 digests', async () => {
    const repo = await seed(fx);
    const bundle = await fx.broker.materialize({ remote: repo.url, token: FAKE_TOKEN, sha: repo.sha });
    expect(bundle.baselineSha).toBe(repo.sha);
    expect(bundle.files.map((f) => f.path).sort()).toEqual(BASE_FILES.map((f) => f.path).sort());
    const readme = bundle.files.find((f) => f.path === 'README.md')!;
    expect(readme.utf8).toBe('# Storefront\n');
    expect(readme.sha256).toBe(`sha256:${createHash('sha256').update('# Storefront\n').digest('hex')}`);
  });

  it('reads an older commit, not the branch tip', async () => {
    const repo = await seed(fx);
    commitRaw(repo.dir, 'main', [{ path: 'README.md', content: 'changed\n' }], repo.sha);
    const bundle = await fx.broker.materialize({ remote: repo.url, token: FAKE_TOKEN, sha: repo.sha });
    expect(bundle.files.find((f) => f.path === 'README.md')!.utf8).toBe('# Storefront\n');
  });

  it('rejects symlinks', async () => {
    const repo = fx.bare('evil');
    const sha = commitRaw(repo.dir, 'main', [
      { path: 'ok.txt', content: 'ok' },
      { path: 'link', mode: '120000', content: '/etc/passwd' },
    ]);
    await expect(fx.broker.materialize({ remote: repo.url, token: FAKE_TOKEN, sha })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('symlink'),
    });
  });

  it('rejects submodules', async () => {
    const repo = fx.bare('evil');
    const sha = commitRaw(repo.dir, 'main', [
      { path: 'ok.txt', content: 'ok' },
      { path: 'vendor/lib', mode: '160000', oid: 'a'.repeat(40) },
    ]);
    await expect(fx.broker.materialize({ remote: repo.url, token: FAKE_TOKEN, sha })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('submodule'),
    });
  });

  it('rejects oversize files and oversize trees', async () => {
    const repo = fx.bare('big');
    const sha = commitRaw(repo.dir, 'main', [
      { path: 'a.txt', content: 'x'.repeat(2000) },
      { path: 'b.txt', content: 'y'.repeat(2000) },
    ]);
    await expect(
      fx.broker.materialize({ remote: repo.url, token: FAKE_TOKEN, sha, maxFileBytes: 1000 }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(
      fx.broker.materialize({ remote: repo.url, token: FAKE_TOKEN, sha, maxTotalBytes: 3000 }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('carries binary and non-UTF-8 files as base64 with a digest over the raw bytes', async () => {
    const repo = fx.bare('bin');
    const raw = Buffer.from([0x89, 0x50, 0x00, 0x01]);
    const bin = commitRaw(repo.dir, 'main', [{ path: 'img.bin', content: raw }]);
    const bundle = await fx.broker.materialize({ remote: repo.url, token: FAKE_TOKEN, sha: bin });
    expect(bundle.files).toEqual([{ path: 'img.bin', utf8: '', base64: raw.toString('base64'), sha256: `sha256:${createHash('sha256').update(raw).digest('hex')}` }]);
    const latin1 = commitRaw(repo.dir, 'other', [{ path: 'l.txt', content: Buffer.from([0x63, 0x61, 0x66, 0xe9]) }]);
    const lb = await fx.broker.materialize({ remote: repo.url, token: FAKE_TOKEN, sha: latin1 });
    expect(lb.files[0]).toMatchObject({ path: 'l.txt', utf8: '', base64: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64') });
  });

  it('reports a missing commit as NOT_FOUND', async () => {
    const repo = await seed(fx);
    await expect(
      fx.broker.materialize({ remote: repo.url, token: FAKE_TOKEN, sha: 'b'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
