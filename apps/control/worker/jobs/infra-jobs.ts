import {
  type Capability,
  type CheckDefinition,
  type CheckResult,
  type EvidenceRef,
  type SourceBundle,
  checkApplicability,
  digestBytes,
} from '@converge/domain';
import { regressionResult, runSuite, type AppTarget } from '@converge/verification';
import type { ServeSpec } from '../runtime-types.ts';
import { deployedTarget, deployedVersion } from './deploy-target.ts';
import type { AssembleOutput } from '@converge/infrastructure/git/ops';
import { evidencePrefix, verifyEvidence, writeEvidence } from '../evidence.ts';
import { type ProjectDefinition, materializeLimits, projectDefinition } from '../projects.ts';
import { type JobContext, once, retrying } from './context.ts';

// ---------------- seed ----------------

export async function runSeed(ctx: JobContext): Promise<void> {
  const { step, coordinator, lease } = ctx;
  const canonicalRepo = String(ctx.input.canonicalRepo);
  const def = projectDefinition(ctx.config.PROJECT_KIND);
  const headSha = def.seed.kind === 'files' ? await seedFromFiles(ctx, canonicalRepo, def) : await seedFromImport(ctx, canonicalRepo, def);
  const baseline = await step.do('read baseline lockfile', retrying, async () => {
    const lock = await ctx.repos.readFile(canonicalRepo, headSha, def.lockfile);
    if (lock === null) throw new Error(`INVALID_STATE baseline has no ${def.lockfile}`);
    return { lockfileDigest: await digestBytes(lock) };
  });
  let snapshotId: string | null = null;
  if (def.runtime.kind === 'project') {
    const runtime = def.runtime;
    snapshotId = await step.do('prepare dependency snapshot', { retries: { limit: 1, delay: '10 seconds', backoff: 'constant' }, timeout: '20 minutes' }, async () => {
      const bundle = await ctx.repos.withTokens([{ name: canonicalRepo, scope: 'read' }], (creds) => {
        const c = creds.get(canonicalRepo)!;
        return ctx.broker.materialize({ remote: c.remote, token: c.token, sha: headSha, ...materializeLimits(ctx.config.PROJECT_KIND) });
      });
      // One prep container per lockfile: Internet on, no secrets, then snapshot.
      const prep = ctx.env.EXECUTION.getByName(`prep-${baseline.lockfileDigest.slice(7, 23)}`);
      const snap = await prep.prepareSnapshot({ bundle, install: runtime.install, prepBuild: runtime.prepBuild, name: `deps-${def.kind}-${baseline.lockfileDigest.slice(7, 19)}` });
      await coordinator.wfProgress(lease.jobId, lease.fence, `Dependency snapshot ready (${Math.round(snap.sizeBytes / 1e6)} MB)`);
      return snap.snapshotId;
    });
  }
  await step.do('record seed', retrying, () => coordinator.wfSeeded(lease.jobId, lease.fence, { headSha, lockfileDigest: baseline.lockfileDigest, snapshotId }));
}

async function seedFromFiles(ctx: JobContext, canonicalRepo: string, def: ProjectDefinition): Promise<string> {
  if (def.seed.kind !== 'files') throw new Error('INVALID_STATE not a file seed');
  const seed = def.seed;
  await ctx.step.do('ensure canonical repo', retrying, async () => {
    await ctx.repos.ensureRepo(canonicalRepo, 'Converge canonical synthetic storefront (MIT, synthetic data only)');
    return { ok: true };
  });
  return ctx.step.do('push baseline', retrying, async () => {
    const out = await ctx.repos.withTokens([{ name: canonicalRepo, scope: 'write' }], (creds) => {
      const c = creds.get(canonicalRepo)!;
      return ctx.broker.seedBaseline({ remote: c.remote, token: c.token, branch: 'main', files: [...seed.files], message: 'Synthetic storefront baseline', timestamp: seed.timestamp });
    });
    return out.headSha;
  });
}

/**
 * Import the pinned upstream commit, then apply the operator setup files in one
 * deterministic commit on top of it. That commit is the session baseline.
 */
async function seedFromImport(ctx: JobContext, canonicalRepo: string, def: ProjectDefinition): Promise<string> {
  if (def.seed.kind !== 'import') throw new Error('INVALID_STATE not an import seed');
  const seed = def.seed;
  await ctx.step.do('import upstream', { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, async () => {
    // Import the upstream default branch (pastebin-worker uses `goshujin`). Converge then creates `main`,
    // the only production branch Workers Builds deploys, as the setup commit on the pinned commit.
    await ctx.repos.ensureImport(canonicalRepo, seed.url, undefined, `Converge canonical import of ${seed.url} (pinned ${seed.commit.slice(0, 12)})`);
    return { ok: true };
  });
  return ctx.step.do('apply setup commit', retrying, async () => {
    const out = await ctx.repos.withTokens([{ name: canonicalRepo, scope: 'write' }], async (creds) => {
      const c = creds.get(canonicalRepo)!;
      const head = (await ctx.broker.readHead({ remote: c.remote, token: c.token, branch: 'main' })).sha;
      // A retry finds main already at the identical deterministic setup commit; anything else is an upstream move.
      return ctx.broker.commitEdits({
        remote: c.remote,
        token: c.token,
        baseSha: seed.commit,
        branch: 'main',
        files: seed.setupFiles.map((f) => ({ path: f.path, utf8: f.utf8 })),
        editablePaths: seed.setupFiles.map((f) => f.path),
        protectedPaths: [],
        message: `Configure ${def.kind} for Converge (operator setup)`,
        timestamp: seed.timestamp,
      }).catch((err: unknown) => {
        throw new Error(`INVALID_STATE setup commit failed (main ${head}, pinned ${seed.commit}): ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    return out.headSha;
  });
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
    // Project mode runs candidates from a dependency snapshot; record it as the execution environment.
    const runtime = await coordinator.getRuntime();
    const image = runtime.kind === 'project' ? `snapshot:${runtime.snapshotId}` : await ctx.env.EXECUTION.getByName('image-probe').imageRef();
    return { status: 'merged' as const, headSha: out.headSha, treeSha: out.treeSha, executionImageDigest: image };
  });
  await step.do('record assembly', retrying, () => coordinator.wfAssembled(lease.jobId, lease.fence, result));
}

// ---------------- verify ----------------

/** Each startFresh() restarts the candidate process inside this attempt's disposable container. */
function containerTarget(ctx: JobContext, serve?: ServeSpec): AppTarget {
  return {
    async startFresh() {
      await ctx.execution.startApp(serve);
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
      return broker.materialize({ remote: c.remote, token: c.token, sha: input.headSha, ...materializeLimits(ctx.config.PROJECT_KIND) });
    });
    const ref = await writeEvidence(env.EVIDENCE, {
      prefix: evidencePrefix(config.PROJECT_SLUG, input.sessionId, 'source'),
      body: bundle,
      visibility: 'private',
    });
    await coordinator.wfRegisterEvidence(lease.jobId, lease.fence, 'source', ref);
    return { key: ref.key, sha256: ref.sha256 };
  });

  const def = projectDefinition(config.PROJECT_KIND);
  const outcome = await step.do('run protected checks', once, async () => {
    const bundle = await verifyEvidence<SourceBundle>(env.EVIDENCE, source.key, source.sha256);
    const meta = { candidateId: input.candidateId, headSha: input.headSha, manifestDigest: input.manifestDigest };
    const caps = input.capabilities as Capability[];
    const timeout = config.TOOL_TIMEOUT_SECONDS * 1000;
    try {
      const loaded = await ctx.execution.load(bundle);
      const build =
        loaded.exitCode !== 0
          ? loaded
          : def.runtime.kind === 'project'
            ? await ctx.execution.runCommand(def.runtime.prepBuild, timeout)
            : await ctx.execution.runTool('build', timeout);
      const log = await writeEvidence(env.EVIDENCE, {
        prefix: evidencePrefix(config.PROJECT_SLUG, input.sessionId, 'logs'),
        body: `$ load + build (${input.headSha})\n${build.output}`,
        visibility: 'private',
      });
      await coordinator.wfRegisterEvidence(lease.jobId, lease.fence, 'log', log);
      let results: CheckResult[];
      if (build.exitCode !== 0) {
        results = buildErrorResults(def.checks, meta, input.harnessDigest, caps, build.timedOut ? 'build timed out' : 'candidate build failed');
      } else {
        const serve = def.runtime.kind === 'project' ? def.runtime.serve : undefined;
        results = await runSuite({ suite: def.suite, target: containerTarget(ctx, serve), capabilities: caps, candidate: meta, maxInstances: 1 });
        if (def.runtime.kind === 'project') results.push(await regressionCheck(ctx, def.runtime.regression, meta, input.harnessDigest));
      }
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
  checks: readonly CheckDefinition[],
  meta: { candidateId: string; headSha: string; manifestDigest: string },
  harnessDigest: string,
  caps: Capability[],
  reason: string,
): CheckResult[] {
  const now = Date.now();
  const set = new Set(caps);
  return checks.map((c) => {
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

/**
 * The project's own test suite runs inside the untrusted container; its JSON
 * report becomes in-container evidence (a lower trust level than black-box checks).
 */
async function regressionCheck(
  ctx: JobContext,
  argv: string[],
  meta: { candidateId: string; headSha: string; manifestDigest: string },
  harness: string,
): Promise<CheckResult> {
  const startedAt = Date.now();
  const run = await ctx.execution.runCommand(argv, 600_000, 4 * 1024 * 1024);
  let report: unknown;
  try {
    report = JSON.parse(run.output);
  } catch {
    report = null;
  }
  return regressionResult({ candidate: meta, harnessDigest: harness, startedAt, finishedAt: Date.now() }, report);
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
  const def = projectDefinition(config.PROJECT_KIND);
  if (result.state === 'succeeded' && def.deploy) await observeDeploy(ctx, def, i.promotionId, i.candidateSha);
}

/**
 * Workers Builds deploys canonical main after the push. Wait until the live
 * Worker reports the promoted commit in its version header, then run the
 * protected black-box checks against production. This records evidence only;
 * promotion authority stays with the guarded push.
 */
async function observeDeploy(ctx: JobContext, def: ProjectDefinition, promotionId: string, sha: string): Promise<void> {
  const url = def.deploy!.url;
  const short = sha.slice(0, 12);
  let version: string | null = null;
  for (let i = 0; i < 40; i++) {
    version = await ctx.step.do(`read deployed version ${i}`, retrying, async () => (await deployedVersion(url).catch(() => null)) ?? '');
    if (version && (version.startsWith(short) || short.startsWith(version))) break;
    await ctx.step.sleep(`wait for deploy ${i}`, '15 seconds');
  }
  const matched = Boolean(version && (version.startsWith(short) || short.startsWith(version)));
  const evidence = await ctx.step.do('verify deployment', { retries: { limit: 1, delay: '10 seconds', backoff: 'constant' }, timeout: '10 minutes' }, async () => {
    const results = matched
      ? await runSuite({
          suite: def.suite,
          target: deployedTarget(url),
          capabilities: [...def.fullGoalCapabilities],
          candidate: { candidateId: 'deployment', headSha: sha, manifestDigest: `sha256:${'0'.repeat(64)}` },
          maxInstances: 1,
        })
      : [];
    const ref = await writeEvidence(ctx.env.EVIDENCE, {
      prefix: evidencePrefix(ctx.config.PROJECT_SLUG, ctx.lease.sessionId ?? 'project', 'receipts'),
      body: { promotionId, url, expectedCommit: sha, observedVersion: version, matched, results, observedAt: Date.now() },
      visibility: 'private',
    });
    const failed = results.filter((r) => r.applicable && r.status !== 'passed').map((r) => r.checkId);
    return { ref, failed, checks: results.filter((r) => r.applicable).length };
  });
  await ctx.step.do('record deployment', retrying, () =>
    ctx.coordinator.wfDeployObserved(promotionId, {
      url,
      expectedCommit: sha,
      observedVersion: version,
      state: !matched ? 'version-mismatch' : evidence.failed.length ? 'checks-failed' : 'verified',
      failedChecks: evidence.failed,
      checks: evidence.checks,
      evidence: evidence.ref,
    }),
  );
}
