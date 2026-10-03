import {
  CHECKS,
  type Capability,
  type CheckResult,
  type EvidenceRef,
  type SourceBundle,
  checkApplicability,
  digestBytes,
} from '@converge/domain';
import { runSuite, type AppTarget } from '@converge/verification';
import type { AssembleOutput } from '@converge/infrastructure/git/ops';
import { evidencePrefix, verifyEvidence, writeEvidence } from '../evidence.ts';
import { SEED_TIMESTAMP, STOREFRONT_FILES } from '../fixtures.ts';
import { type JobContext, once, retrying } from './context.ts';

// ---------------- seed ----------------

export async function runSeed(ctx: JobContext): Promise<void> {
  const { lease, step, repos, broker, coordinator } = ctx;
  const canonicalRepo = String(ctx.input.canonicalRepo);
  await step.do('ensure canonical repo', retrying, async () => {
    await repos.ensureRepo(canonicalRepo, 'Converge canonical synthetic storefront (MIT, synthetic data only)');
    return { ok: true };
  });
  const seeded = await step.do('push baseline', retrying, async () => {
    const out = await repos.withTokens([{ name: canonicalRepo, scope: 'write' }], (creds) => {
      const c = creds.get(canonicalRepo)!;
      return broker.seedBaseline({
        remote: c.remote,
        token: c.token,
        branch: 'main',
        files: [...STOREFRONT_FILES],
        message: 'Synthetic storefront baseline',
        timestamp: SEED_TIMESTAMP,
      });
    });
    const lock = STOREFRONT_FILES.find((f) => f.path === 'package-lock.json');
    if (!lock) throw new Error('INVALID_STATE storefront fixture has no package-lock.json');
    return { headSha: out.headSha, lockfileDigest: await digestBytes(lock.utf8) };
  });
  await step.do('record seed', retrying, () => coordinator.wfSeeded(lease.jobId, lease.fence, seeded));
}

// ---------------- integrate ----------------

export async function runIntegrate(ctx: JobContext): Promise<void> {
  const { lease, step, repos, broker, coordinator } = ctx;
  const plan = await step.do('read assembly plan', retrying, () => coordinator.wfAssembly(lease.jobId, lease.fence));
  await step.do('ensure integration repo', retrying, async () => {
    await repos.ensureFork(plan.canonicalRepo, plan.targetRepo, 'Converge integration candidates (synthetic)');
    return { ok: true };
  });
  const result = await step.do('assemble candidate', retrying, async () => {
    const names = [
      { name: plan.targetRepo, scope: 'write' as const },
      { name: plan.start.repo, scope: 'read' as const },
      ...plan.merges.map((m) => ({ name: m.repo, scope: 'read' as const })),
    ];
    const out = await repos.withTokens<AssembleOutput>(names, async (creds) => {
      const auth = (n: string) => ({ remote: creds.get(n)!.remote, token: creds.get(n)!.token });
      return broker.assemble({
        target: { ...auth(plan.targetRepo), branch: plan.branch },
        start: { ...auth(plan.start.repo), sha: plan.start.sha },
        merges: plan.merges.map((m) => ({ ...auth(m.repo), sha: m.sha, label: m.label })),
        message: plan.message,
        timestamp: plan.timestamp,
      });
    });
    if (out.status === 'text_conflict') {
      return { status: 'text_conflict' as const, conflictedPaths: out.conflictedPaths, atMerge: out.atMerge };
    }
    const image = await ctx.env.EXECUTION.getByName('image-probe').imageRef();
    return { status: 'merged' as const, headSha: out.headSha, treeSha: out.treeSha, executionImageDigest: image };
  });
  await step.do('record assembly', retrying, () => coordinator.wfAssembled(lease.jobId, lease.fence, result));
}

// ---------------- verify ----------------

/** Each startFresh() restarts the candidate process inside this attempt's disposable container. */
function containerTarget(ctx: JobContext): AppTarget {
  return {
    async startFresh() {
      await ctx.execution.startApp();
      return {
        request: (req) => ctx.execution.appRequest(req),
        stop: () => ctx.execution.stopApp(),
      };
    },
  };
}

export async function runVerify(ctx: JobContext): Promise<void> {
  const { lease, step, repos, broker, coordinator, env, config } = ctx;
  const input = await step.do('read verification input', retrying, () => coordinator.wfVerifyInput(lease.jobId, lease.fence));
  const source = await step.do('materialize candidate source', retrying, async () => {
    const bundle = await repos.withTokens([{ name: input.repoName, scope: 'read' }], (creds) => {
      const c = creds.get(input.repoName)!;
      return broker.materialize({ remote: c.remote, token: c.token, sha: input.headSha });
    });
    const ref = await writeEvidence(env.EVIDENCE, {
      prefix: evidencePrefix(config.PROJECT_SLUG, input.sessionId, 'source'),
      body: bundle,
      visibility: 'private',
    });
    await coordinator.wfRegisterEvidence(lease.jobId, lease.fence, 'source', ref);
    return { key: ref.key, sha256: ref.sha256 };
  });

  const outcome = await step.do('run protected checks', once, async () => {
    const bundle = await verifyEvidence<SourceBundle>(env.EVIDENCE, source.key, source.sha256);
    try {
      const loaded = await ctx.execution.load(bundle);
      const build = loaded.exitCode === 0 ? await ctx.execution.runTool('build', config.TOOL_TIMEOUT_SECONDS * 1000) : loaded;
      const log = await writeEvidence(env.EVIDENCE, {
        prefix: evidencePrefix(config.PROJECT_SLUG, input.sessionId, 'logs'),
        body: `$ load + build (${input.headSha})\n${build.output}`,
        visibility: 'private',
      });
      await coordinator.wfRegisterEvidence(lease.jobId, lease.fence, 'log', log);
      const meta = { candidateId: input.candidateId, headSha: input.headSha, manifestDigest: input.manifestDigest };
      const caps = input.capabilities as Capability[];
      const results: CheckResult[] =
        build.exitCode === 0
          ? await runSuite({ target: containerTarget(ctx), capabilities: caps, candidate: meta, maxInstances: 1 })
          : buildErrorResults(meta, input.harnessDigest, caps, build.timedOut ? 'build timed out' : 'candidate build failed');
      for (const r of results) {
        const ref: EvidenceRef = await writeEvidence(env.EVIDENCE, {
          prefix: evidencePrefix(config.PROJECT_SLUG, input.sessionId, 'checks'),
          body: r,
          visibility: 'private',
        });
        await coordinator.wfRecordCheck(lease.jobId, lease.fence, r, ref);
      }
      return { buildFailed: build.exitCode !== 0, message: build.exitCode !== 0 ? build.output.slice(-2000) : '' };
    } finally {
      await ctx.execution.destroyContainer('verification finished').catch(() => undefined);
    }
  });
  await step.do('finish verification', retrying, () =>
    coordinator.wfVerified(lease.jobId, lease.fence, outcome.buildFailed ? { message: outcome.message } : undefined),
  );
}

function buildErrorResults(
  meta: { candidateId: string; headSha: string; manifestDigest: string },
  harnessDigest: string,
  caps: Capability[],
  reason: string,
): CheckResult[] {
  const now = Date.now();
  const set = new Set(caps);
  return CHECKS.map((c) => {
    const a = checkApplicability(c, set);
    return {
      schemaVersion: 1 as const,
      checkId: c.id,
      candidateId: meta.candidateId,
      candidateHeadSha: meta.headSha,
      candidateManifestDigest: meta.manifestDigest,
      harnessDigest,
      status: a.applicable ? ('error' as const) : ('skipped' as const),
      applicable: a.applicable,
      applicabilityReason: a.applicable ? `${a.reason}; ${reason}` : a.reason,
      assertionCount: 0,
      failedCount: 0,
      observations: [],
      startedAt: now,
      finishedAt: now,
    };
  });
}

// ---------------- promote ----------------

export async function runPromote(ctx: JobContext): Promise<void> {
  const { lease, step, repos, broker, coordinator, env, config } = ctx;
  const i = ctx.input as { canonicalRepo: string; sourceRepo: string; candidateSha: string; expectedMainSha: string; promotionId: string };
  const result = await step.do('guarded push', retrying, async () => {
    const out = await repos.withTokens(
      [
        { name: i.canonicalRepo, scope: 'write' },
        { name: i.sourceRepo, scope: 'read' },
      ],
      (creds) =>
        broker.promote({
          canonical: { remote: creds.get(i.canonicalRepo)!.remote, token: creds.get(i.canonicalRepo)!.token },
          source: { remote: creds.get(i.sourceRepo)!.remote, token: creds.get(i.sourceRepo)!.token },
          candidateSha: i.candidateSha,
          expectedMainSha: i.expectedMainSha,
        }),
    );
    const receipt = await writeEvidence(env.EVIDENCE, {
      prefix: evidencePrefix(config.PROJECT_SLUG, lease.sessionId ?? 'project', 'receipts'),
      body: { promotionId: i.promotionId, ...out, candidateSha: i.candidateSha, expectedMainSha: i.expectedMainSha, observedAt: Date.now() },
      visibility: 'private',
    });
    return { ...out, receipt };
  });
  await step.do('record promotion', retrying, () =>
    coordinator.wfPromotionResult(lease.jobId, lease.fence, {
      state: result.state,
      observedRemoteSha: result.observedRemoteSha,
      reconciled: result.reconciled,
      receipt: result.receipt,
    }),
  );
}
