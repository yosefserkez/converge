// End-to-end checks of the pastebin harness against the pinned upstream
// pastebin-worker with the setup files and fixture patches. Needs git, pnpm,
// and (on the first run) network access. Later runs reuse the cached checkout.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capability, CheckResult } from '@converge/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harnessDigest, runSuite } from '../src/index.ts';
import { loadProjectFixturePatch, loadProjectManifest, loadProjectSetupFiles } from '../src/fixture-patches.ts';
import type { ProjectFixtureRole } from '../src/patch-manifest.ts';
import { LocalWranglerTarget } from '../src/projects/pastebin/local-target.ts';
import { regressionResult } from '../src/projects/pastebin/regression.ts';
import { resultInvariantViolations } from '../src/result.ts';
import {
  buildPastebinWorkspace,
  createPastebinRoot,
  ensureUpstream,
  runArgv,
  trackedFiles,
  upstreamCached,
  upstreamReachable,
} from './helpers/pastebin-workspace.ts';

const TIMEOUT = 300_000;
const manifest = await loadProjectManifest('pastebin');
const available = (await upstreamCached(manifest)) || (await upstreamReachable(manifest));
if (!available) {
  console.warn(`pastebin.test.ts skipped: ${manifest.source.url} is not reachable and no cached checkout exists.`);
}

const ROLE_CAPABILITY: Partial<Record<ProjectFixtureRole, Capability>> = {
  storage: 'view-limits',
  'api-ui': 'view-limits-ui',
  delivery: 'conditional-get',
};

const STORAGE_PATH = 'worker/storage/storage.ts';
const CONSUME_GUARD = 'if (!expired && isViewLimited(metadata)) {';

interface Variant {
  name: string;
  roles: ProjectFixtureRole[];
  /** Test-only file changes on top of the patches. */
  extra?: (files: Record<string, string>) => Record<string, string>;
  /** Run the project Vitest suite too. */
  unit?: boolean;
}

const VARIANTS: Variant[] = [
  { name: 'baseline', roles: [], unit: true },
  { name: 'storage', roles: ['storage'], unit: true },
  { name: 'api-ui', roles: ['api-ui'], unit: true },
  { name: 'delivery', roles: ['delivery'], unit: true },
  { name: 'storage+delivery', roles: ['storage', 'delivery'], unit: true },
  { name: 'all+repair', roles: ['storage', 'api-ui', 'delivery', 'repair'], unit: true },
  {
    // A "repair" that passes cache safety by not counting views at all.
    name: 'all+repair-no-views',
    roles: ['storage', 'api-ui', 'delivery', 'repair'],
    extra: (files) => {
      const storage = files[STORAGE_PATH] ?? '';
      if (!storage.includes(CONSUME_GUARD)) throw new Error('storage patch no longer has the consume guard');
      return { [STORAGE_PATH]: storage.replace(CONSUME_GUARD, 'if (!expired && isViewLimited(metadata) && false) {') };
    },
  },
];

const CANDIDATE = { candidateId: 'cand-pastebin-1', headSha: 'a'.repeat(40), manifestDigest: `sha256:${'b'.repeat(64)}` };

let root = '';
const dirs = new Map<string, string>();
const targets: LocalWranglerTarget[] = [];
const suites = new Map<string, CheckResult[]>();

function capabilitiesFor(roles: readonly ProjectFixtureRole[]): Capability[] {
  return roles.flatMap((role) => {
    const capability = ROLE_CAPABILITY[role];
    return capability ? [capability] : [];
  });
}

function target(dir: string): LocalWranglerTarget {
  const t = new LocalWranglerTarget({ dir, serveArgv: manifest.runtime.serve.argv, readyPath: manifest.runtime.serve.readyPath });
  targets.push(t);
  return t;
}

async function suiteFor(name: string, capabilities?: Capability[]): Promise<CheckResult[]> {
  const variant = VARIANTS.find((v) => v.name === name);
  const dir = dirs.get(name);
  if (!variant || !dir) throw new Error(`unknown variant ${name}`);
  const key = capabilities ? `${name}:${capabilities.join(',')}` : name;
  const cached = suites.get(key);
  if (cached) return cached;
  const out = await runSuite({
    suite: 'pastebin',
    target: target(dir),
    capabilities: capabilities ?? capabilitiesFor(variant.roles),
    candidate: CANDIDATE,
    maxInstances: 2,
    checkTimeoutMs: 120_000,
  });
  suites.set(key, out);
  return out;
}

function byId(list: CheckResult[], id: string): CheckResult {
  const found = list.find((r) => r.checkId === id);
  if (!found) throw new Error(`missing result ${id}`);
  return found;
}

function statuses(list: CheckResult[]): Record<string, string> {
  return Object.fromEntries(list.map((r) => [r.checkId, r.status]));
}

function failures(list: CheckResult[]): Record<string, string[]> {
  return Object.fromEntries(
    list
      .filter((r) => r.status !== 'passed' && r.status !== 'skipped')
      .map((r) => [r.checkId, r.observations.filter((o) => !o.passed).map((o) => `${o.label}: expected ${JSON.stringify(o.expected)} observed ${JSON.stringify(o.observed)}`)]),
  );
}

async function regressionFor(name: string): Promise<CheckResult> {
  const dir = dirs.get(name) ?? '';
  const startedAt = Date.now();
  // The regression command prints only the JSON report, like the container tool runner sees it.
  const run = await runArgv(manifest.runtime.regression, dir, 300_000);
  let report: unknown = null;
  try {
    report = JSON.parse(run.output) as unknown;
  } catch {
    // regressionResult reports an unreadable report as an error.
  }
  const result = regressionResult({ candidate: CANDIDATE, harnessDigest: await harnessDigest('pastebin'), startedAt, finishedAt: Date.now() }, report);
  if (result.status !== 'passed') {
    const log = await readFile(join(dir, '.converge/vitest.log'), 'utf8').catch(() => '');
    console.warn(`${name} regression exit ${run.exitCode}: ${log.slice(-1500)}`);
  }
  return result;
}

describe.skipIf(!available)('pastebin harness against the pinned upstream', () => {
  beforeAll(async () => {
    const repo = await ensureUpstream(manifest);
    const files = await trackedFiles(repo);
    const setup = await loadProjectSetupFiles(manifest);
    root = await createPastebinRoot();
    for (const variant of VARIANTS) {
      let overlay: Record<string, string> = { ...setup };
      for (const role of variant.roles) Object.assign(overlay, (await loadProjectFixturePatch(manifest, role)).files);
      if (variant.extra) overlay = { ...overlay, ...variant.extra(overlay) };
      dirs.set(variant.name, await buildPastebinWorkspace({ manifest, repo, files, root, name: variant.name.replace(/\+/g, '_'), overlay }));
    }
  }, 900_000);

  afterAll(async () => {
    await Promise.all(targets.map((t) => t.stopAll()));
    if (root) await rm(root, { recursive: true, force: true });
  }, 60_000);

  it('baseline passes every applicable check and skips the capability checks', async () => {
    const list = await suiteFor('baseline');
    expect(failures(list)).toEqual({});
    expect(statuses(list)).toEqual({
      'paste.roundtrip': 'passed',
      'views.limit': 'skipped',
      'views.cache-safety': 'skipped',
      'delivery.conditional': 'skipped',
      'views.display': 'skipped',
    });
    for (const r of list) {
      expect(resultInvariantViolations(r)).toEqual([]);
      expect(r.harnessDigest).toBe(await harnessDigest('pastebin'));
    }
  }, TIMEOUT);

  it('storage alone passes views.limit and views.cache-safety', async () => {
    const list = await suiteFor('storage');
    expect(failures(list)).toEqual({});
    expect(statuses(list)).toMatchObject({ 'paste.roundtrip': 'passed', 'views.limit': 'passed', 'views.cache-safety': 'passed', 'views.display': 'skipped' });
  }, TIMEOUT);

  it('api-ui alone passes views.display', async () => {
    const list = await suiteFor('api-ui');
    expect(failures(list)).toEqual({});
    expect(statuses(list)).toMatchObject({ 'paste.roundtrip': 'passed', 'views.display': 'passed', 'views.limit': 'skipped' });
  }, TIMEOUT);

  it('delivery alone passes delivery.conditional', async () => {
    const list = await suiteFor('delivery');
    expect(failures(list)).toEqual({});
    expect(statuses(list)).toMatchObject({ 'paste.roundtrip': 'passed', 'delivery.conditional': 'passed', 'views.limit': 'skipped' });
  }, TIMEOUT);

  it.each(['baseline', 'storage', 'api-ui', 'delivery', 'storage+delivery', 'all+repair'])(
    '%s passes the project Vitest suite (paste.regression)',
    async (name) => {
      const result = await regressionFor(name);
      expect(result.status).toBe('passed');
      expect(result.assertionCount).toBeGreaterThan(150);
      expect(result.applicabilityReason).toContain('in-container evidence');
      expect(resultInvariantViolations(result)).toEqual([]);
    },
    TIMEOUT,
  );

  it('storage+delivery fails views.cache-safety: a 304 skips a view and a limited paste is served past its limit', async () => {
    const list = await suiteFor('storage+delivery');
    const safety = byId(list, 'views.cache-safety');
    expect(safety.status).toBe('failed');
    expect(safety.observations).toContainEqual(expect.objectContaining({ label: 'conditional read 2 status', expected: 200, observed: 304, passed: false }));
    expect(safety.observations).toContainEqual(expect.objectContaining({ label: 'read 3 status (two views used)', expected: 404, observed: 200, passed: false }));
    expect(safety.observations).toContainEqual(expect.objectContaining({ label: 'read 1 sends no ETag', expected: '', passed: false }));
    // Each member passes its own checks; plain reads still count views.
    expect(statuses(list)).toMatchObject({ 'paste.roundtrip': 'passed', 'views.limit': 'passed', 'delivery.conditional': 'passed', 'views.display': 'skipped' });
  }, TIMEOUT);

  it('all three patches plus the repair pass every check', async () => {
    const list = await suiteFor('all+repair');
    expect(failures(list)).toEqual({});
    expect(statuses(list)).toEqual({
      'paste.roundtrip': 'passed',
      'views.limit': 'passed',
      'views.cache-safety': 'passed',
      'delivery.conditional': 'passed',
      'views.display': 'passed',
    });
  }, TIMEOUT);

  it('a repair that stops counting views fails views.limit', async () => {
    const list = await suiteFor('all+repair-no-views');
    const limit = byId(list, 'views.limit');
    expect(limit.status).toBe('failed');
    expect(limit.observations).toContainEqual(expect.objectContaining({ label: 'read 3 status (limit reached)', expected: 404, observed: 200, passed: false }));
    expect(byId(list, 'views.cache-safety').status).toBe('failed');
  }, TIMEOUT);

  it('checks have teeth when capabilities are claimed but not implemented', async () => {
    const list = await suiteFor('baseline', ['view-limits', 'view-limits-ui', 'conditional-get']);
    expect(statuses(list)).toEqual({
      'paste.roundtrip': 'passed',
      'views.limit': 'failed',
      'views.cache-safety': 'failed',
      'delivery.conditional': 'failed',
      'views.display': 'failed',
    });
  }, TIMEOUT);

  it('stops every wrangler instance it started', () => {
    expect(targets.reduce((n, t) => n + t.liveCount, 0)).toBe(0);
  });
});
