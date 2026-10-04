// Node-only helpers for the pastebin tests: one cached upstream checkout with
// installed dependencies, and cheap per-variant workspaces on top of it.
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectManifest } from '@converge/domain';

const run = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

export interface ToolRun {
  exitCode: number;
  output: string;
}

/** Runs one argv in a directory. A nonzero exit is a result, not an exception. */
export async function runArgv(argv: readonly string[], cwd: string, timeoutMs: number): Promise<ToolRun> {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error('empty argv');
  try {
    const { stdout, stderr } = await run(command, args, { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, env: { ...process.env, NO_COLOR: '1', CI: '1' } });
    return { exitCode: 0, output: stdout + stderr };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return { exitCode: typeof e.code === 'number' ? e.code : 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function cacheRoot(manifest: ProjectManifest): string {
  return join(tmpdir(), 'converge-pastebin-cache', manifest.source.commit);
}

/** True when a previous run left a checked-out, installed upstream copy. */
export async function upstreamCached(manifest: ProjectManifest): Promise<boolean> {
  return exists(join(cacheRoot(manifest), 'ready.json'));
}

/** True when the upstream repository answers. Used to skip the tests when offline. */
export async function upstreamReachable(manifest: ProjectManifest): Promise<boolean> {
  const probe = await runArgv(['git', 'ls-remote', manifest.source.url, 'HEAD'], tmpdir(), 20_000);
  return probe.exitCode === 0;
}

/**
 * Clones and installs the pinned upstream once, under the OS temp directory.
 * Later runs reuse it. Returns the checkout directory.
 */
export async function ensureUpstream(manifest: ProjectManifest): Promise<string> {
  const root = cacheRoot(manifest);
  const repo = join(root, 'repo');
  const marker = join(root, 'ready.json');
  if (await exists(marker)) return repo;
  await rm(repo, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const steps: [string, readonly string[], string][] = [
    ['clone', ['git', 'clone', '--quiet', manifest.source.url, repo], root],
    ['checkout', ['git', 'checkout', '--quiet', '--detach', manifest.source.commit], repo],
    ['install', manifest.runtime.install, repo],
  ];
  for (const [label, argv, cwd] of steps) {
    const result = await runArgv(argv, cwd, 600_000);
    if (result.exitCode !== 0) throw new Error(`upstream ${label} failed: ${result.output.slice(-2000)}`);
  }
  const head = await runArgv(['git', 'rev-parse', 'HEAD'], repo, 30_000);
  if (head.output.trim() !== manifest.source.commit) throw new Error(`upstream HEAD ${head.output.trim()} is not ${manifest.source.commit}`);
  await writeFile(marker, JSON.stringify({ commit: manifest.source.commit, preparedAt: new Date().toISOString() }));
  return repo;
}

/** Tracked upstream files (no node_modules, no build output). */
export async function trackedFiles(repo: string): Promise<string[]> {
  const listed = await runArgv(['git', 'ls-files', '-z'], repo, 30_000);
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.output}`);
  return listed.output.split('\0').filter((p) => p.length > 0);
}

/**
 * Builds one workspace: copies the tracked upstream files, writes the overlay
 * files (setup, then patches, in order), links the cached node_modules, and
 * runs the project's prep build. Returns the workspace directory.
 */
export async function buildPastebinWorkspace(input: {
  manifest: ProjectManifest;
  repo: string;
  files: readonly string[];
  root: string;
  name: string;
  overlay: Readonly<Record<string, string>>;
}): Promise<string> {
  const dir = join(input.root, input.name);
  for (const path of input.files) {
    if (path in input.overlay) continue;
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await copyFile(join(input.repo, path), join(dir, path));
  }
  for (const [path, content] of Object.entries(input.overlay)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  await symlink(join(input.repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const build = await runArgv(input.manifest.runtime.prepBuild, dir, 300_000);
  if (build.exitCode !== 0) throw new Error(`prep build failed for ${input.name}: ${build.output.slice(-2000)}`);
  return dir;
}

export async function createPastebinRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'converge-pastebin-ws-'));
}
