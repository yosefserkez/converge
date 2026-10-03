// Deterministic pipeline with real Git and the real protected harness, no Cloudflare account:
// seed -> sealed forks -> merged candidates -> failing pair -> anchored repair -> passing
// final candidate -> lease-guarded promotion of the exact tested commit.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Capability, type ChangeIntent, type CheckResult, type SourceBundle, BASELINE_FACTS, PROTECTED_PATHS, STOREFRONT_TASKS, detectInteractions, digestOf } from '@converge/domain';
import { GitBroker } from '@converge/infrastructure/git/index';
import { runSuite } from '@converge/verification';
import { LocalProcessTarget } from '../../packages/verification/src/local-target.ts';
import { STOREFRONT_DIR, loadFixturePatch, loadStorefrontBaseline } from '../../packages/verification/src/fixture-patches.ts';

const run = promisify(execFile);
const T0 = 1_790_000_000;
const TOKEN = 'local-test-token';

let root: string;
let broker: GitBroker;
const remote = (name: string) => pathToFileURL(join(root, 'remotes', `${name}.git`)).href;

async function bare(name: string) {
  await run('git', ['init', '--quiet', '--bare', '--initial-branch=main', join(root, 'remotes', `${name}.git`)]);
  return remote(name);
}

/** Build a materialized bundle in a temp dir and run the trusted harness against it. */
async function verify(label: string, bundle: SourceBundle, capabilities: Capability[], headSha: string): Promise<CheckResult[]> {
  const dir = join(root, 'builds', label.replace(/[^a-z0-9]+/gi, '-'));
  for (const f of bundle.files) {
    await mkdir(dirname(join(dir, f.path)), { recursive: true });
    await writeFile(join(dir, f.path), f.utf8);
  }
  await symlink(join(STOREFRONT_DIR, 'node_modules'), join(dir, 'node_modules'), 'dir');
  await run(process.execPath, ['build.mjs'], { cwd: dir, timeout: 60_000 });
  return runSuite({
    target: new LocalProcessTarget({ dir }),
    capabilities,
    candidate: { candidateId: `cand_${label.toLowerCase().replace(/[^a-z0-9]+/g, '')}`.slice(0, 30), headSha, manifestDigest: await digestOf({ headSha }) },
    maxInstances: 1,
  });
}

const status = (results: CheckResult[]) => Object.fromEntries(results.map((r) => [r.checkId, r.status]));
const task = (role: string) => STOREFRONT_TASKS.find((t) => t.role === role)!;

describe('deterministic pipeline with real Git and the protected harness', { timeout: 240_000 }, () => {
  const heads: Record<string, string> = {};
  let baseline = '';
  let pairHead = '';

  beforeAll(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), 'converge-pipeline-')));
    mkdirSync(join(root, 'remotes'));
    mkdirSync(join(root, 'work'));
    broker = new GitBroker({ testFileRemoteRoot: join(root, 'remotes'), workRoot: join(root, 'work') });
    const files = await loadStorefrontBaseline();
    const canonical = await bare('canonical');
    const seeded = await broker.seedBaseline({
      remote: canonical,
      token: TOKEN,
      branch: 'main',
      files: Object.entries(files).map(([path, utf8]) => ({ path, utf8 })),
      message: 'Synthetic storefront baseline',
      timestamp: T0,
    });
    baseline = seeded.headSha;
    await bare('integration');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('the declared intents predict the pricing/caching interaction', async () => {
    const [pricing, caching, checkout] = await Promise.all(['pricing', 'caching', 'checkout'].map((r) => loadFixturePatch(r as never)));
    const predicted = detectInteractions({
      baselineFacts: BASELINE_FACTS,
      proposals: [
        { proposalId: 'pricing', intentDigest: 'a', intent: pricing!.intent as ChangeIntent, ordinal: 0 },
        { proposalId: 'caching', intentDigest: 'b', intent: caching!.intent as ChangeIntent, ordinal: 1 },
        { proposalId: 'checkout', intentDigest: 'c', intent: checkout!.intent as ChangeIntent, ordinal: 2 },
      ],
    });
    expect(predicted.some((i) => i.kind === 'assumption' && i.contractKey === 'unit-price.dimensions' && i.leftProposalId === 'pricing' && i.rightProposalId === 'caching')).toBe(true);
  });

  it('seals each fixture agent as a real commit in its own fork, inside its scope', async () => {
    for (const role of ['pricing', 'caching', 'checkout'] as const) {
      const patch = await loadFixturePatch(role);
      const fork = await bare(`fork-${role}`);
      const out = await broker.commitEdits({
        remote: fork,
        token: TOKEN,
        baseSha: baseline,
        branch: `converge/${role}`,
        files: Object.entries(patch.files).map(([path, utf8]) => ({ path, utf8 })),
        editablePaths: task(role).editablePaths,
        protectedPaths: PROTECTED_PATHS,
        message: `${task(role).title}: fixture patch`,
        timestamp: T0 + 10,
        sourceRemote: remote('canonical'),
        sourceToken: TOKEN,
      });
      heads[role] = out.headSha;
      expect(out.changedPaths.every((p) => task(role).editablePaths.includes(p))).toBe(true);
    }
    // A protected edit is refused at the broker as well.
    await expect(
      broker.commitEdits({
        remote: remote('fork-pricing'), token: TOKEN, baseSha: baseline, branch: 'converge/evil',
        files: [{ path: 'src/server.ts', utf8: '// forged' }], editablePaths: task('pricing').editablePaths, protectedPaths: PROTECTED_PATHS,
        message: 'forge', timestamp: T0 + 11, sourceRemote: remote('canonical'), sourceToken: TOKEN,
      }),
    ).rejects.toThrow(/PROTECTED_PATH/);
  });

  async function candidate(label: string, members: Array<keyof typeof heads>, start = { remote: remote('canonical'), sha: baseline }) {
    const out = await broker.assemble({
      target: { remote: remote('integration'), token: TOKEN, branch: `candidates/${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` },
      start: { ...start, token: TOKEN },
      merges: members.map((m) => ({ remote: remote(`fork-${m}`), token: TOKEN, sha: heads[m]!, label: m })),
      message: `Converge candidate ${label}`,
      timestamp: T0 + 20,
    });
    if (out.status !== 'merged') throw new Error(`text conflict in ${label}`);
    const bundle = await broker.materialize({ remote: remote('integration'), token: TOKEN, sha: out.headSha });
    return { head: out.headSha, bundle };
  }

  it('each change passes alone under its own capabilities', async () => {
    const caps: Record<string, Capability> = { pricing: 'membership-pricing', caching: 'quote-cache', checkout: 'checkout-summary' };
    for (const role of ['pricing', 'caching', 'checkout'] as const) {
      const c = await candidate(role, [role]);
      const results = await verify(role, c.bundle, [caps[role]!], c.head);
      expect(results.every((r) => r.status === 'passed' || r.status === 'skipped'), JSON.stringify(status(results))).toBe(true);
    }
  });

  it('pricing + caching merge cleanly and fail customer isolation with a concrete counterexample', async () => {
    const c = await candidate('pair', ['pricing', 'caching']);
    pairHead = c.head;
    const results = await verify('pair', c.bundle, ['membership-pricing', 'quote-cache'], c.head);
    const isolation = results.find((r) => r.checkId === 'pricing.isolation')!;
    expect(isolation.status).toBe('failed');
    expect(isolation.observations.find((o) => !o.passed)).toMatchObject({ label: 'seq1 step2 regular-1 backpack unitPriceCents', expected: 10000, observed: 8000 });
  });

  it('an additive repair on the failed commit, merged through that anchor, passes everything', async () => {
    const repair = await loadFixturePatch('repair');
    const fork = await bare('fork-repair');
    const sealed = await broker.commitEdits({
      remote: fork, token: TOKEN, baseSha: pairHead, branch: 'converge/repair',
      files: Object.entries(repair.files).map(([path, utf8]) => ({ path, utf8 })),
      editablePaths: [...task('pricing').editablePaths, ...task('caching').editablePaths], protectedPaths: PROTECTED_PATHS,
      message: 'Repair 1: cache key includes membership tier', timestamp: T0 + 30, sourceRemote: remote('integration'), sourceToken: TOKEN,
    });
    heads.repair = sealed.headSha;
    // The anchor already contains pricing and caching; only checkout and the repair merge in.
    const final = await broker.assemble({
      target: { remote: remote('integration'), token: TOKEN, branch: 'candidates/final' },
      start: { remote: remote('integration'), token: TOKEN, sha: pairHead },
      merges: (['pricing', 'caching', 'checkout', 'repair'] as const).map((m) => ({ remote: remote(`fork-${m}`), token: TOKEN, sha: heads[m]!, label: m })),
      message: 'Converge candidate Full goal + Repair 1',
      timestamp: T0 + 40,
    });
    if (final.status !== 'merged') throw new Error('text conflict');
    expect(final.alreadyIncluded.sort()).toEqual(['caching', 'pricing']);
    const bundle = await broker.materialize({ remote: remote('integration'), token: TOKEN, sha: final.headSha });
    const results = await verify('final', bundle, ['membership-pricing', 'quote-cache', 'checkout-summary'], final.headSha);
    expect(results.every((r) => r.status === 'passed'), JSON.stringify(status(results))).toBe(true);
    expect(results.find((r) => r.checkId === 'cache.reuse')!.assertionCount).toBeGreaterThan(0);

    // Promote the exact tested commit; main must equal it, and a stale second promotion must not move main.
    const promoted = await broker.promote({
      canonical: { remote: remote('canonical'), token: TOKEN },
      source: { remote: remote('integration'), token: TOKEN },
      candidateSha: final.headSha,
      expectedMainSha: baseline,
    });
    expect(promoted).toMatchObject({ state: 'succeeded', observedRemoteSha: final.headSha });
    const stale = await broker.promote({
      canonical: { remote: remote('canonical'), token: TOKEN },
      source: { remote: remote('integration'), token: TOKEN },
      candidateSha: pairHead,
      expectedMainSha: baseline,
    });
    expect(stale.state).toBe('stale');
    expect((await broker.readHead({ remote: remote('canonical'), token: TOKEN, branch: 'main' })).sha).toBe(final.headSha);
    const { stdout } = await run('git', ['--git-dir', join(root, 'remotes', 'canonical.git'), 'merge-base', '--is-ancestor', pairHead, final.headSha]).then(() => ({ stdout: 'ancestor' }));
    expect(stdout).toBe('ancestor');
  });
});
