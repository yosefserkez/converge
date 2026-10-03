import { DomainError } from '@converge/domain';
import type { z } from 'zod';
import type { PromoteInput, PromoteOutput } from './ops.ts';
import { fetchCommit, isAncestor, lsRemoteBranch } from './repo.ts';
import type { OpWorkspace } from './workspace.ts';

type PromoteIn = z.output<typeof PromoteInput>;

const MAIN = 'main';

/**
 * Exact promotion (brief section 9): compare-and-swap canonical main from
 * `expectedMainSha` to the tested `candidateSha` with an explicit lease, after
 * proving ancestry. Never blanket-forces, rebases or re-merges.
 */
export async function promote(ws: OpWorkspace, input: PromoteIn): Promise<PromoteOutput> {
  const { canonical, source, candidateSha, expectedMainSha } = input;
  ws.addRemote(canonical.remote, canonical.token);
  ws.addRemote(source.remote, source.token);

  const observed = await lsRemoteBranch(ws, canonical.remote, MAIN);
  if (observed === candidateSha) return { state: 'succeeded', observedRemoteSha: observed, reconciled: true, pushed: false };
  if (observed !== expectedMainSha) return { state: 'stale', observedRemoteSha: observed, reconciled: false, pushed: false };

  await fetchCommit(ws, canonical.remote, expectedMainSha);
  await fetchCommit(ws, source.remote, candidateSha);
  if (!(await isAncestor(ws, expectedMainSha, candidateSha))) {
    throw new DomainError('NOT_PROMOTABLE', 'candidate does not descend from the expected main commit', {
      candidateSha,
      expectedMainSha,
    });
  }

  const res = await ws.git(
    [
      'push',
      '--porcelain',
      '--no-verify',
      `--force-with-lease=refs/heads/${MAIN}:${expectedMainSha}`,
      '--',
      canonical.remote,
      `${candidateSha}:refs/heads/${MAIN}`,
    ],
    { okExitCodes: [1, 128] },
  );

  const after = await lsRemoteBranch(ws, canonical.remote, MAIN);
  if (after === candidateSha) return { state: 'succeeded', observedRemoteSha: after, reconciled: res.code !== 0, pushed: res.code === 0 };
  if (after === expectedMainSha) return { state: 'failed', observedRemoteSha: after, reconciled: false, pushed: false };
  return { state: 'stale', observedRemoteSha: after, reconciled: false, pushed: false };
}
