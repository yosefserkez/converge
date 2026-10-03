// Test fixtures for the Git broker: local bare repos used as file:// remotes.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitBroker } from '../src/git/index.ts';

export const FAKE_TOKEN = 'cfart_FAKE_SECRET_TOKEN_9f8e7d6c5b4a';
export const T0 = 1_760_000_000;

export interface Fixture {
  readonly root: string;
  readonly workRoot: string;
  readonly broker: GitBroker;
  readonly logs: string[];
  bare(name: string): { dir: string; url: string };
  cleanup(): void;
  /** Leftover per-op temp dirs (should always be empty after ops finish). */
  leftovers(): string[];
}

export function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'converge-broker-test-')));
  const remotes = path.join(root, 'remotes');
  const workRoot = path.join(root, 'work');
  mkdirSync(remotes);
  mkdirSync(workRoot);
  const logs: string[] = [];
  const broker = new GitBroker({ testFileRemoteRoot: remotes, workRoot, log: (l) => logs.push(l) });
  return {
    root,
    workRoot,
    broker,
    logs,
    bare(name) {
      const dir = path.join(remotes, `${name}.git`);
      git(root, ['init', '--quiet', '--bare', '--initial-branch=main', dir]);
      return { dir, url: pathToFileURL(dir).href };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
    leftovers() {
      return readdirSync(workRoot);
    },
  };
}

function testEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_AUTHOR_DATE: '@1700000000 +0000',
    GIT_COMMITTER_DATE: '@1700000000 +0000',
    ...extra,
  };
}

export function git(cwd: string, args: string[], extra: Record<string, string> = {}, input?: string): string {
  const res = spawnSync('git', args, { cwd, env: testEnv(cwd, extra), input, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

export interface RawEntry {
  readonly path: string;
  readonly mode?: string;
  readonly content?: string | Buffer;
  /** Pre-existing object id, e.g. a fake commit id for a submodule entry. */
  readonly oid?: string;
}

/** Writes an arbitrary (possibly hostile) commit straight into a bare repo and points `branch` at it. */
export function commitRaw(bareDir: string, branch: string, entries: RawEntry[], parent?: string, message = 'raw'): string {
  const env = { GIT_DIR: bareDir, GIT_INDEX_FILE: path.join(bareDir, `raw-index-${Date.now()}-${Math.random()}`) };
  const lines: string[] = [];
  for (const e of entries) {
    let oid = e.oid;
    if (!oid) {
      const res = spawnSync('git', ['hash-object', '-w', '--stdin'], { env: testEnv(bareDir, env), input: e.content ?? '' });
      oid = res.stdout.toString().trim();
    }
    lines.push(`${e.mode ?? '100644'} ${oid}\t${e.path}`);
  }
  git(bareDir, ['update-index', '--add', '--index-info'], env, `${lines.join('\n')}\n`);
  const tree = git(bareDir, ['write-tree'], env).trim();
  const sha = git(bareDir, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], env).trim();
  git(bareDir, ['update-ref', `refs/heads/${branch}`, sha], env);
  rmSync(env.GIT_INDEX_FILE, { force: true });
  return sha;
}

export function revParse(bareDir: string, rev: string): string {
  return git(bareDir, ['rev-parse', rev], { GIT_DIR: bareDir }).trim();
}

export function catFile(bareDir: string, rev: string, file: string): string {
  return git(bareDir, ['show', `${rev}:${file}`], { GIT_DIR: bareDir });
}

export function isAncestor(bareDir: string, a: string, b: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', a, b], { env: testEnv(bareDir, { GIT_DIR: bareDir }) }).status === 0;
}

export const BASE_FILES = [
  { path: 'README.md', utf8: '# Storefront\n' },
  { path: 'src/server.ts', utf8: 'export const server = 1;\n' },
  { path: 'src/pricing/compute-unit-price.ts', utf8: 'export const price = (c: number) => c;\n' },
  { path: 'src/pricing/quote-cache.ts', utf8: 'export const cache = new Map();\n' },
  { path: 'src/ui/CheckoutSummary.tsx', utf8: 'line1\nline2\nline3\n' },
];

export async function seed(fx: Fixture, name = 'canonical'): Promise<{ dir: string; url: string; sha: string }> {
  const repo = fx.bare(name);
  const res = await fx.broker.seedBaseline({
    remote: repo.url,
    token: FAKE_TOKEN,
    branch: 'main',
    files: BASE_FILES,
    message: 'Baseline',
    timestamp: T0,
  });
  return { ...repo, sha: res.headSha };
}
