// Low-level Git plumbing on an OpWorkspace. No working tree is ever checked
// out: trees are built in a private index and merges use `merge-tree`, so
// no filters, hooks, or symlinks touch the filesystem.
import path from 'node:path';
import { DomainError } from '@converge/domain';
import { BROKER_IDENTITY, type OpWorkspace } from './workspace.ts';

const SHA = /^[0-9a-f]{40}$/;

export interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
  readonly path: string;
}

/** Exact-match branch lookup. Returns null when the branch does not exist. */
export async function lsRemoteBranch(ws: OpWorkspace, remote: string, branch: string): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const out = await ws.gitText(['ls-remote', '--refs', remote, ref], { maxOutputBytes: 1024 * 1024 });
  for (const line of out.split('\n')) {
    const [sha, name] = line.split('\t');
    if (name === ref && sha && SHA.test(sha)) return sha;
  }
  return null;
}

export async function hasCommit(ws: OpWorkspace, sha: string): Promise<boolean> {
  const res = await ws.git(['cat-file', '-e', `${sha}^{commit}`], { okExitCodes: [1, 128] });
  return res.code === 0;
}

/**
 * Fetches an exact commit into the private repo. Tries a by-SHA fetch first
 * (protocol v2 servers allow it); falls back to fetching all branches and
 * checking that the commit arrived.
 */
export async function fetchCommit(ws: OpWorkspace, remote: string, sha: string): Promise<void> {
  if (await hasCommit(ws, sha)) return;
  const base = ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules'];
  const bySha = await ws.git([...base, '--', remote, `+${sha}:${ws.nextFetchRef()}`], { okExitCodes: [1, 128] });
  if (bySha.code === 0 && (await hasCommit(ws, sha))) return;
  await ws.git([...base, '--', remote, `+refs/heads/*:${ws.nextFetchRef()}/*`]);
  if (!(await hasCommit(ws, sha))) {
    throw new DomainError('NOT_FOUND', `commit ${sha} is not reachable from the remote`, { sha });
  }
}

/** Fetches a branch tip into the private repo; returns its SHA or null if the branch is absent. */
export async function fetchBranch(ws: OpWorkspace, remote: string, branch: string): Promise<string | null> {
  const sha = await lsRemoteBranch(ws, remote, branch);
  if (sha) await fetchCommit(ws, remote, sha);
  return sha;
}

export async function treeOf(ws: OpWorkspace, commit: string): Promise<string> {
  return (await ws.gitText(['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`])).trim();
}

export async function parentsOf(ws: OpWorkspace, commit: string): Promise<string[]> {
  const line = (await ws.gitText(['rev-list', '--parents', '-n', '1', commit, '--'])).trim();
  return line.split(' ').slice(1);
}

export async function isAncestor(ws: OpWorkspace, ancestor: string, descendant: string): Promise<boolean> {
  const res = await ws.git(['merge-base', '--is-ancestor', ancestor, descendant], { okExitCodes: [1] });
  return res.code === 0;
}

export async function hashBlob(ws: OpWorkspace, content: string): Promise<string> {
  const out = await ws.gitText(['hash-object', '-w', '--no-filters', '--stdin'], { stdin: Buffer.from(content, 'utf8') });
  return out.trim();
}

/** Reads a tree recursively into entries (mode, oid, path). */
export async function readTree(ws: OpWorkspace, treeish: string): Promise<TreeEntry[]> {
  const out = await ws.git(['ls-tree', '-r', '-z', '--full-tree', treeish, '--']);
  const entries: TreeEntry[] = [];
  for (const record of out.stdout.toString('utf8').split('\0')) {
    if (!record) continue;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/s.exec(record);
    if (!m) throw new DomainError('INTERNAL', 'unexpected ls-tree output');
    entries.push({ mode: m[1]!, oid: m[3]!, path: m[4]! });
  }
  return entries;
}

/**
 * Writes a tree from a complete entry list using a throwaway index. Rejects
 * file/directory collisions (e.g. `a` and `a/b`) instead of letting git pick.
 */
export async function writeTree(ws: OpWorkspace, entries: readonly TreeEntry[]): Promise<string> {
  const paths = new Set(entries.map((e) => e.path));
  for (const p of paths) {
    let dir = path.posix.dirname(p);
    while (dir !== '.') {
      if (paths.has(dir)) throw new DomainError('INVALID_INPUT', `path ${p} collides with file ${dir}`);
      dir = path.posix.dirname(dir);
    }
  }
  const indexFile = path.join(ws.dir, `index-${Math.random().toString(36).slice(2)}`);
  const extraEnv = { GIT_INDEX_FILE: indexFile };
  const info = entries.map((e) => `${e.mode} ${e.oid}\t${e.path}`).join('\0');
  await ws.git(['update-index', '--add', '-z', '--index-info'], { stdin: entries.length ? `${info}\0` : '', extraEnv });
  return (await ws.gitText(['write-tree'], { extraEnv })).trim();
}

export function commitEnv(timestamp: number): Record<string, string> {
  const date = `@${timestamp} +0000`;
  return {
    GIT_AUTHOR_NAME: BROKER_IDENTITY.name,
    GIT_AUTHOR_EMAIL: BROKER_IDENTITY.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: BROKER_IDENTITY.name,
    GIT_COMMITTER_EMAIL: BROKER_IDENTITY.email,
    GIT_COMMITTER_DATE: date,
  };
}

/** Deterministic commit: same tree, parents, message and timestamp yield the same SHA. */
export async function commitTree(
  ws: OpWorkspace,
  tree: string,
  parents: readonly string[],
  message: string,
  timestamp: number,
): Promise<string> {
  const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'];
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return (await ws.gitText(args, { stdin: body, extraEnv: commitEnv(timestamp) })).trim();
}

/**
 * Pushes `sha` to `refs/heads/<branch>` without force. If the branch already
 * holds `sha` nothing is pushed. A fast-forward is accepted; anything else is
 * rejected by the remote. Always confirms the result with ls-remote.
 */
export async function pushBranch(ws: OpWorkspace, remote: string, branch: string, sha: string): Promise<{ pushed: boolean }> {
  const before = await lsRemoteBranch(ws, remote, branch);
  if (before === sha) return { pushed: false };
  const res = await ws.git(['push', '--porcelain', '--no-verify', '--', remote, `${sha}:refs/heads/${branch}`], {
    okExitCodes: [1, 128],
  });
  const after = await lsRemoteBranch(ws, remote, branch);
  if (after === sha) return { pushed: res.code === 0 };
  if (res.code !== 0 && after === before) {
    throw new DomainError('INVALID_STATE', `branch ${branch} points to a different commit; refusing to overwrite`, {
      observedSha: after,
    });
  }
  throw new DomainError('INVALID_STATE', `remote branch ${branch} does not match the pushed commit after push`, {
    observedSha: after,
  });
}
