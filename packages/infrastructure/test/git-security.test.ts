import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitBroker, Redactor, REDACTED, assertAllowedRemote, matchesPattern } from '../src/git/index.ts';
import { OpWorkspace } from '../src/git/workspace.ts';
import { FAKE_TOKEN, T0, createFixture, seed, type Fixture } from './git-helpers.ts';

const ARTIFACTS_URL = 'https://abc123.artifacts.cloudflare.net/git/converge/cv-session-a.git';

describe('Redactor', { timeout: 30_000 }, () => {
  it('removes registered secrets and generic credential patterns', () => {
    const r = new Redactor([FAKE_TOKEN]);
    const text = [
      `fatal: token ${FAKE_TOKEN} rejected`,
      'Authorization: Bearer some-unregistered-value',
      'curl -H "authorization: basic Zm9vOmJhcg=="',
      'remote: https://user:hunter2@example.com/repo.git',
      'http.https://x/.extraheader=Authorization: Bearer zzz',
    ].join('\n');
    const out = r.redact(text);
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).not.toContain('some-unregistered-value');
    expect(out).not.toContain('Zm9vOmJhcg==');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('zzz');
    expect(out).toContain(REDACTED);
  });

  it('ignores very short strings so it does not shred ordinary text', () => {
    expect(new Redactor(['a']).redact('banana')).toBe('banana');
  });
});

describe('remote allowlist', { timeout: 30_000 }, () => {
  it('accepts only Artifacts smart-HTTP remotes in production', () => {
    expect(() => assertAllowedRemote(ARTIFACTS_URL, {})).not.toThrow();
    for (const bad of [
      'http://abc123.artifacts.cloudflare.net/git/ns/repo.git',
      'https://abc123.artifacts.cloudflare.net.evil.com/git/ns/repo.git',
      'https://evil.com/git/ns/repo.git',
      'https://user:pw@abc123.artifacts.cloudflare.net/git/ns/repo.git',
      'https://abc123.artifacts.cloudflare.net/git/ns/../repo.git',
      'https://abc123.artifacts.cloudflare.net/git/ns/repo.git?x=1',
      'ext::sh -c touch% /tmp/pwned',
      'file:///tmp/repo.git',
      '--upload-pack=touch /tmp/pwned',
    ]) {
      expect(() => assertAllowedRemote(bad, {}), bad).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    }
  });

  it('allows file:// only beneath the configured test root', () => {
    const policy = { fileRemoteRoot: '/srv/remotes' };
    expect(() => assertAllowedRemote('file:///srv/remotes/a.git', policy)).not.toThrow();
    expect(() => assertAllowedRemote('file:///srv/other/a.git', policy)).toThrow();
    expect(() => assertAllowedRemote('file:///srv/remotes/../other/a.git', policy)).toThrow();
    expect(() => assertAllowedRemote('file:///srv/remotes', policy)).toThrow();
  });

  it('a production broker rejects file:// remotes', async () => {
    const work = realpathSync(mkdtempSync(path.join(tmpdir(), 'converge-prod-')));
    try {
      const broker = new GitBroker({ workRoot: work });
      const url = pathToFileURL(path.join(work, 'x.git')).href;
      await expect(broker.readHead({ remote: url, token: FAKE_TOKEN, branch: 'main' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('path patterns', { timeout: 30_000 }, () => {
  it('treats /** as a directory prefix and everything else as exact', () => {
    expect(matchesPattern('public/a/b.css', 'public/**')).toBe(true);
    expect(matchesPattern('public', 'public/**')).toBe(false);
    expect(matchesPattern('publicity.ts', 'public/**')).toBe(false);
    expect(matchesPattern('src/a.ts', 'src/a.ts')).toBe(true);
    expect(matchesPattern('src/a.tsx', 'src/a.ts')).toBe(false);
  });
});

describe('credential handling', { timeout: 30_000 }, () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = createFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it('scopes the auth header to the exact remote via git config, never argv', async () => {
    const ws = await OpWorkspace.create({ workRoot: fx.workRoot });
    try {
      ws.addRemote(ARTIFACTS_URL, FAKE_TOKEN);
      const header = await ws.gitText(['config', '--get-urlmatch', 'http.extraheader', ARTIFACTS_URL]);
      expect(header.trim()).toBe(`Authorization: Bearer ${FAKE_TOKEN}`);
      const other = await ws.git(
        ['config', '--get-urlmatch', 'http.extraheader', 'https://abc123.artifacts.cloudflare.net/git/converge/other.git'],
        { okExitCodes: [1] },
      );
      expect(other.stdout.toString()).toBe('');
    } finally {
      await ws.dispose();
    }
  });

  it('rejects tokens that could inject header lines', async () => {
    const repo = fx.bare('r');
    await expect(
      fx.broker.readHead({ remote: repo.url, token: `${FAKE_TOKEN}\r\nX-Evil: 1`, branch: 'main' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('never leaks the token into errors or logs', async () => {
    const base = await seed(fx);
    const messages: string[] = [];
    const capture = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (err) {
        messages.push(String((err as Error).message), JSON.stringify(err));
      }
    };
    const missing = pathToFileURL(path.join(path.dirname(base.dir), 'does-not-exist.git')).href;
    await capture(fx.broker.readHead({ remote: missing, token: FAKE_TOKEN, branch: 'main' }));
    await capture(fx.broker.materialize({ remote: missing, token: FAKE_TOKEN, sha: base.sha }));
    await capture(
      fx.broker.commitEdits({
        remote: base.url,
        token: FAKE_TOKEN,
        baseSha: base.sha,
        branch: 'main',
        files: [{ path: 'src/server.ts', utf8: FAKE_TOKEN }],
        editablePaths: ['src/**'],
        protectedPaths: ['src/server.ts'],
        message: `message mentioning ${FAKE_TOKEN}`,
        timestamp: T0,
      }),
    );
    // Malformed body: wrong type next to the token.
    const raw = await fx.broker.dispatch('readHead', { remote: base.url, token: FAKE_TOKEN, branch: 42 });
    messages.push(JSON.stringify(raw));
    const unknown = await fx.broker.dispatch('shell', { cmd: 'id', token: FAKE_TOKEN });
    messages.push(JSON.stringify(unknown));

    expect(messages.length).toBeGreaterThanOrEqual(6);
    expect(raw).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(fx.logs.length).toBeGreaterThanOrEqual(6);
    for (const text of [...messages, ...fx.logs]) expect(text).not.toContain(FAKE_TOKEN);
    expect(fx.logs.every((l) => /^git-broker op=\w+ outcome=\S+ durationMs=\d+$/.test(l))).toBe(true);
  });

  it('removes per-operation temp dirs after success and failure', async () => {
    const base = await seed(fx);
    await fx.broker.readHead({ remote: base.url, token: FAKE_TOKEN, branch: 'main' });
    await fx.broker.materialize({ remote: base.url, token: FAKE_TOKEN, sha: 'c'.repeat(40) }).catch(() => undefined);
    expect(fx.leftovers()).toEqual([]);
  });
});
