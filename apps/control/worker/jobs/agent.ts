import { type SourceBundle, type TaskSpec } from '@converge/domain';
import { evidencePrefix, verifyEvidence, writeEvidence } from '../evidence.ts';
import { loadFixturePatch } from '../fixtures.ts';
import { type JobContext, retrying } from './context.ts';
import { runLiveAgent } from './live-agent.ts';
import { materializeLimits } from '../projects.ts';

export interface AgentInput {
  sessionId: string;
  proposalId: string;
  mode: 'live' | 'fixture';
  role: 'pricing' | 'caching' | 'checkout' | 'repair';
  baseRepo: string;
  baseSha: string;
  proposalRepo: string;
  counterexample?: unknown;
}

export async function runAgent(ctx: JobContext): Promise<void> {
  const input = ctx.input as unknown as AgentInput;
  await ctx.step.do('mark working', retrying, () => ctx.coordinator.wfMarkWorking(ctx.lease.jobId, ctx.lease.fence));
  const baseline = await materializeBaseline(ctx, input);
  if (input.mode === 'fixture') {
    await runFixtureAgent(ctx, input, baseline);
  } else {
    await runLiveAgent(ctx, input, baseline);
  }
}

/** Fetch the exact pinned base commit through the broker and store it as verified evidence. */
export async function materializeBaseline(ctx: JobContext, input: AgentInput): Promise<{ key: string; sha256: string }> {
  return ctx.step.do('materialize pinned baseline', retrying, async () => {
    const bundle = await ctx.repos.withTokens([{ name: input.baseRepo, scope: 'read' }], (creds) => {
      const c = creds.get(input.baseRepo)!;
      return ctx.broker.materialize({ remote: c.remote, token: c.token, sha: input.baseSha, ...materializeLimits(ctx.config.PROJECT_KIND) });
    });
    if (bundle.baselineSha !== input.baseSha) throw new Error('INVALID_STATE broker returned a different commit');
    const ref = await writeEvidence(ctx.env.EVIDENCE, {
      prefix: evidencePrefix(ctx.config.PROJECT_SLUG, input.sessionId, 'source'),
      body: bundle,
      visibility: 'private',
    });
    await ctx.coordinator.wfRegisterEvidence(ctx.lease.jobId, ctx.lease.fence, 'source', ref);
    return { key: ref.key, sha256: ref.sha256 };
  });
}

/** Checked-in A/B/C/repair patches through the same seal + verification pipeline. No model calls. */
async function runFixtureAgent(ctx: JobContext, input: AgentInput, baseline: { key: string; sha256: string }) {
  const patch = loadFixturePatch(ctx.config.PROJECT_KIND, input.role);
  const startedAt = await ctx.step.do('declare fixture intent', retrying, async () => {
    const now = Date.now();
    await ctx.coordinator.wfActivity(ctx.lease.jobId, ctx.lease.fence, { id: `${ctx.lease.jobId}-fx`, kind: 'fixture', label: 'apply checked-in patch', startedAt: now });
    await ctx.coordinator.wfProgress(ctx.lease.jobId, ctx.lease.fence, 'Fixture agent (no model call): declaring checked-in intent');
    const current = await ctx.coordinator.getProposal(input.proposalId);
    if (current.intents.length === 0) {
      await ctx.coordinator.wfDeclareIntent(ctx.lease.jobId, ctx.lease.fence, 0, patch.intent);
    }
    return now;
  });
  const edits = await ctx.step.do('compute fixture edits', retrying, async () => {
    const bundle = await verifyEvidence<SourceBundle>(ctx.env.EVIDENCE, baseline.key, baseline.sha256);
    const current = new Map(bundle.files.map((f) => [f.path, f.utf8]));
    return Object.entries(patch.files)
      .filter(([path, utf8]) => current.get(path) !== utf8)
      .map(([path, utf8]) => ({ path, utf8 }));
  });
  await sealRevision(ctx, input, edits, patch.summary, startedAt);
}

/**
 * Seal validated edits: the broker rebuilds the tree from the trusted base plus
 * the edits, commits deterministically, pushes to the proposal's own fork, and
 * verifies the remote head. The coordinator then validates scope and records
 * an immutable revision.
 */
export async function sealRevision(
  ctx: JobContext,
  input: AgentInput,
  edits: Array<{ path: string; utf8: string | null }>,
  summary: string,
  startedAt: number,
): Promise<void> {
  if (edits.length === 0) {
    await ctx.step.do('report empty change', retrying, () =>
      ctx.coordinator.wfAgentBlocked(ctx.lease.jobId, ctx.lease.fence, 'agent finished without changing any file', 'NO_CHANGES'),
    );
    return;
  }
  const proposal = await ctx.step.do('read task', retrying, async () => {
    const p = await ctx.coordinator.getProposal(input.proposalId);
    return { task: p.taskSpec as TaskSpec };
  });
  await ctx.step.do('ensure proposal fork', retrying, async () => {
    await ctx.repos.ensureFork(input.baseRepo, input.proposalRepo, `Converge proposal fork (${input.role}, synthetic)`);
    return { ok: true };
  });
  const sealed = await ctx.step.do('commit and push revision', retrying, async () => {
    const out = await ctx.repos.withTokens(
      [
        { name: input.proposalRepo, scope: 'write' },
        { name: input.baseRepo, scope: 'read' },
      ],
      (creds) => {
        const target = creds.get(input.proposalRepo)!;
        const source = creds.get(input.baseRepo)!;
        return ctx.broker.commitEdits({
          remote: target.remote,
          token: target.token,
          baseSha: input.baseSha,
          branch: `converge/${ctx.lease.jobId}`,
          files: edits,
          editablePaths: proposal.task.editablePaths,
          // The task's frozen forbiddenPaths come from the project registry.
          protectedPaths: [...proposal.task.forbiddenPaths],
          message: `${proposal.task.title}: ${commitSubject(summary)}`,
          timestamp: Math.floor(startedAt / 1000),
          sourceRemote: source.remote,
          sourceToken: source.token,
        });
      },
    );
    const diff = await writeEvidence(ctx.env.EVIDENCE, {
      prefix: evidencePrefix(ctx.config.PROJECT_SLUG, input.sessionId, 'diffs'),
      body: out.diffTruncated ? `${out.diff}\n[diff truncated]` : out.diff,
      visibility: 'private',
    });
    return { headSha: out.headSha, treeSha: out.treeSha, changedPaths: out.changedPaths, diff };
  });
  await ctx.step.do('record sealed revision', retrying, async () => {
    await ctx.coordinator.wfActivity(ctx.lease.jobId, ctx.lease.fence, {
      id: `${ctx.lease.jobId}-fx`,
      kind: input.mode === 'fixture' ? 'fixture' : 'tool',
      label: input.mode === 'fixture' ? 'apply checked-in patch' : 'seal revision',
      startedAt,
      finishedAt: Date.now(),
    });
    return ctx.coordinator.wfSeal(ctx.lease.jobId, ctx.lease.fence, {
      headSha: sealed.headSha,
      treeSha: sealed.treeSha,
      baseSha: input.baseSha,
      repoName: input.proposalRepo,
      changedPaths: sealed.changedPaths,
      diff: sealed.diff,
      summary,
    });
  });
}

/** First plain sentence of an agent summary, without Markdown markers, for a commit subject. */
export function commitSubject(summary: string): string {
  const line =
    summary
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').trim())
      .find((l) => l.length > 0 && !/^(implementation |repair )?summary:?$/i.test(l) && !/^(objective|implemented behavior)( (achieved|completed))?:?$/i.test(l)) ?? 'sealed revision';
  return line.slice(0, 120);
}
