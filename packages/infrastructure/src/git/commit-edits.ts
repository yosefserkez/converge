import { DomainError } from '@converge/domain';
import type { z } from 'zod';
import type { CommitEditsInput, CommitEditsOutput } from './ops.ts';
import { assertBranch, assertEditable } from './paths.ts';
import { commitTree, fetchCommit, hasCommit, hashBlob, pushBranch, readTree, treeOf, writeTree, type TreeEntry } from './repo.ts';
import type { OpWorkspace } from './workspace.ts';

type CommitEditsIn = z.output<typeof CommitEditsInput>;

const MAX_EDIT_FILE_BYTES = 256 * 1024;
const MAX_EDIT_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_DIFF_BYTES = 64 * 1024;

export async function commitEdits(ws: OpWorkspace, input: CommitEditsIn): Promise<CommitEditsOutput> {
  assertBranch(input.branch);
  validateEdits(input);
  ws.addRemote(input.remote, input.token);
  if (input.sourceRemote !== undefined) {
    if (input.sourceToken === undefined) throw new DomainError('INVALID_INPUT', 'sourceToken is required with sourceRemote');
    ws.addRemote(input.sourceRemote, input.sourceToken);
  }

  await fetchBase(ws, input);
  const tree = new Map<string, TreeEntry>((await readTree(ws, input.baseSha)).map((e) => [e.path, e]));
  const baseTree = await treeOf(ws, input.baseSha);

  for (const edit of input.files) {
    const existing = tree.get(edit.path);
    if (existing && existing.mode !== '100644' && existing.mode !== '100755') {
      throw new DomainError('INVALID_INPUT', `cannot edit symlink or submodule at ${edit.path}`, { path: edit.path });
    }
    if (edit.utf8 === null) {
      tree.delete(edit.path);
    } else {
      tree.set(edit.path, { mode: existing?.mode ?? '100644', oid: await hashBlob(ws, edit.utf8), path: edit.path });
    }
  }
  const treeSha = await writeTree(ws, [...tree.values()].sort((a, b) => (a.path < b.path ? -1 : 1)));
  if (treeSha === baseTree) throw new DomainError('INVALID_INPUT', 'edit set produces no change');

  const headSha = await commitTree(ws, treeSha, [input.baseSha], input.message, input.timestamp);
  const changedPaths = (await ws.gitText(['diff-tree', '-r', '-z', '--name-only', '--no-renames', input.baseSha, headSha]))
    .split('\0')
    .filter(Boolean);
  const diff = await boundedDiff(ws, input.baseSha, headSha);
  const { pushed } = await pushBranch(ws, input.remote, input.branch, headSha);
  return { headSha, treeSha, changedPaths, diff: diff.text, diffTruncated: diff.truncated, pushed };
}

function validateEdits(input: CommitEditsIn): void {
  const seen = new Set<string>();
  let total = 0;
  for (const edit of input.files) {
    assertEditable(edit.path, input.editablePaths, input.protectedPaths);
    if (seen.has(edit.path)) throw new DomainError('INVALID_INPUT', `duplicate edit for ${edit.path}`);
    seen.add(edit.path);
    if (edit.utf8 === null) continue;
    const bytes = Buffer.byteLength(edit.utf8, 'utf8');
    if (bytes > MAX_EDIT_FILE_BYTES) throw new DomainError('LIMIT_EXCEEDED', `edit exceeds ${MAX_EDIT_FILE_BYTES} bytes: ${edit.path}`);
    if (edit.utf8.includes('\0')) throw new DomainError('INVALID_INPUT', `binary content not allowed: ${edit.path}`);
    total += bytes;
  }
  if (total > MAX_EDIT_TOTAL_BYTES) throw new DomainError('LIMIT_EXCEEDED', `edits exceed ${MAX_EDIT_TOTAL_BYTES} bytes`);
}

/** Base commit comes from the target fork, or from `sourceRemote` when the fork lacks it. */
async function fetchBase(ws: OpWorkspace, input: CommitEditsIn): Promise<void> {
  try {
    await fetchCommit(ws, input.remote, input.baseSha);
    return;
  } catch (err) {
    if (input.sourceRemote === undefined) throw err;
  }
  await fetchCommit(ws, input.sourceRemote, input.baseSha);
  if (!(await hasCommit(ws, input.baseSha))) throw new DomainError('NOT_FOUND', 'base commit not found');
}

async function boundedDiff(ws: OpWorkspace, from: string, to: string): Promise<{ text: string; truncated: boolean }> {
  const res = await ws.git(
    ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', from, to, '--'],
    { maxOutputBytes: MAX_DIFF_BYTES, truncateOutput: true },
  );
  // Cut at a character boundary so truncation never yields broken UTF-8.
  const text = new TextDecoder('utf-8').decode(res.stdout).replace(/�+$/, '');
  return res.truncated
    ? { text: `${text}\n[diff truncated at ${MAX_DIFF_BYTES} bytes]\n`, truncated: true }
    : { text, truncated: false };
}
