import { DomainError } from '@converge/domain';
import type { z } from 'zod';
import type { AssembleInput, AssembleOutput } from './ops.ts';
import { assertBranch } from './paths.ts';
import { commitTree, fetchCommit, isAncestor, parentsOf, pushBranch, treeOf } from './repo.ts';
import type { OpWorkspace } from './workspace.ts';

type AssembleIn = z.output<typeof AssembleInput>;
type MergeStep = Extract<AssembleOutput, { status: 'merged' }>['steps'][number];

/**
 * Starts at `start.sha` (frozen baseline, or an anchor candidate head for
 * additive repairs) and merges each head in order with a real two-parent
 * merge commit. Merges run through `git merge-tree --write-tree`, which does
 * a native three-way merge without a working tree.
 */
export async function assemble(ws: OpWorkspace, input: AssembleIn): Promise<AssembleOutput> {
  assertBranch(input.target.branch);
  const labels = new Set<string>();
  for (const m of input.merges) {
    if (labels.has(m.label)) throw new DomainError('INVALID_INPUT', `duplicate merge label ${m.label}`);
    labels.add(m.label);
  }
  ws.addRemote(input.target.remote, input.target.token);
  ws.addRemote(input.start.remote, input.start.token);
  for (const m of input.merges) ws.addRemote(m.remote, m.token);

  await fetchCommit(ws, input.start.remote, input.start.sha);
  for (const m of input.merges) await fetchCommit(ws, m.remote, m.sha);

  let head = input.start.sha;
  const steps: MergeStep[] = [];
  const alreadyIncluded: string[] = [];
  for (const m of input.merges) {
    if (await isAncestor(ws, m.sha, head)) {
      alreadyIncluded.push(m.label);
      continue;
    }
    const res = await ws.git(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', head, m.sha], {
      okExitCodes: [1],
    });
    const [tree = '', ...rest] = res.stdout.toString('utf8').split('\0');
    if (res.code === 1) {
      const conflictedPaths = [...new Set(rest.filter(Boolean))].sort();
      return { status: 'text_conflict', atMerge: m.label, conflictedPaths, alreadyIncluded };
    }
    if (!/^[0-9a-f]{40}$/.test(tree)) throw new DomainError('INTERNAL', 'unexpected merge-tree output');
    const message = `${input.message}\n\nMerge ${m.label} (${m.sha})\n`;
    const commitSha = await commitTree(ws, tree, [head, m.sha], message, input.timestamp);
    steps.push({ label: m.label, sha: m.sha, commitSha, parents: [head, m.sha] });
    head = commitSha;
  }

  const { pushed } = await pushBranch(ws, input.target.remote, input.target.branch, head);
  return {
    status: 'merged',
    headSha: head,
    treeSha: await treeOf(ws, head),
    parents: await parentsOf(ws, head),
    startSha: input.start.sha,
    steps,
    alreadyIncluded,
    pushed,
  };
}
