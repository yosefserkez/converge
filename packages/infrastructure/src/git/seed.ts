import { DomainError } from '@converge/domain';
import type { z } from 'zod';
import type { ReadHeadInput, SeedBaselineInput, SeedBaselineOutput } from './ops.ts';
import { assertBranch, assertRepoPath } from './paths.ts';
import { commitTree, fetchCommit, hashBlob, lsRemoteBranch, pushBranch, treeOf, writeTree } from './repo.ts';
import type { OpWorkspace } from './workspace.ts';

type SeedIn = z.output<typeof SeedBaselineInput>;
type ReadHeadIn = z.output<typeof ReadHeadInput>;

export async function seedBaseline(ws: OpWorkspace, input: SeedIn): Promise<SeedBaselineOutput> {
  ws.addRemote(input.remote, input.token);
  assertBranch(input.branch);
  const seen = new Set<string>();
  for (const f of input.files) {
    assertRepoPath(f.path);
    if (seen.has(f.path)) throw new DomainError('INVALID_INPUT', `duplicate path ${f.path}`);
    seen.add(f.path);
  }

  const entries = [];
  for (const f of [...input.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    entries.push({ mode: '100644', oid: await hashBlob(ws, f.utf8), path: f.path });
  }
  const treeSha = await writeTree(ws, entries);

  const existing = await lsRemoteBranch(ws, input.remote, input.branch);
  if (existing) {
    await fetchCommit(ws, input.remote, existing);
    const existingTree = await treeOf(ws, existing);
    if (existingTree !== treeSha) {
      throw new DomainError('INVALID_STATE', `branch ${input.branch} already exists with a different tree`, {
        observedSha: existing,
      });
    }
    return { headSha: existing, treeSha, created: false };
  }

  const headSha = await commitTree(ws, treeSha, [], input.message, input.timestamp);
  const { pushed } = await pushBranch(ws, input.remote, input.branch, headSha);
  return { headSha, treeSha, created: pushed };
}

export async function readHead(ws: OpWorkspace, input: ReadHeadIn): Promise<{ sha: string | null }> {
  ws.addRemote(input.remote, input.token);
  assertBranch(input.branch);
  return { sha: await lsRemoteBranch(ws, input.remote, input.branch) };
}
