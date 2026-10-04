// Pastebin harness rules that need no upstream checkout.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHECKS_BY_SUITE, evaluateAssumption, matchesAny, PASTEBIN_CHECKS } from '@converge/domain';
import { describe, expect, it } from 'vitest';
import { blackBoxChecks, harnessDigest, multipartBody, regressionResult, runSuite, type AppTarget } from '../src/index.ts';
import { loadProjectFixturePatch, loadProjectManifest, loadProjectSetupFiles, PROJECTS_DIR } from '../src/fixture-patches.ts';
import { isProtectedPath, PROJECT_FIXTURE_ROLES, type ProjectFixtureRole } from '../src/patch-manifest.ts';
import { resultInvariantViolations } from '../src/result.ts';

const CANDIDATE = { candidateId: 'cand-test-1', headSha: 'c'.repeat(40), manifestDigest: `sha256:${'d'.repeat(64)}` };
const DIGEST = `sha256:${'e'.repeat(64)}`;
const META = { candidate: CANDIDATE, harnessDigest: DIGEST, startedAt: 1, finishedAt: 2 };

function report(tests: { file?: string; title: string; status: string }[], fileStatus = 'passed') {
  const files = new Map<string, { title: string; status: string }[]>();
  for (const t of tests) files.set(t.file ?? '/w/worker/test/a.spec.ts', [...(files.get(t.file ?? '/w/worker/test/a.spec.ts') ?? []), t]);
  return {
    numTotalTests: tests.length,
    success: tests.every((t) => t.status === 'passed'),
    testResults: [...files].map(([name, list]) => ({
      name,
      status: fileStatus,
      message: '',
      assertionResults: list.map((t) => ({ title: t.title, fullName: t.title, status: t.status, failureMessages: t.status === 'failed' ? ['boom'] : [] })),
    })),
  };
}

describe('regressionResult (in-container evidence)', () => {
  it('passes when every test passed: one assertion per test', () => {
    const r = regressionResult(META, report([{ title: 'a', status: 'passed' }, { title: 'b', status: 'passed' }]));
    expect(r).toMatchObject({ checkId: 'paste.regression', status: 'passed', assertionCount: 2, failedCount: 0, applicable: true });
    expect(r.applicabilityReason).toContain('in-container evidence');
    expect(resultInvariantViolations(r)).toEqual([]);
  });

  it('fails when a test failed', () => {
    const r = regressionResult(META, report([{ title: 'a', status: 'passed' }, { title: 'b', status: 'failed' }]));
    expect(r).toMatchObject({ status: 'failed', assertionCount: 2, failedCount: 1 });
    expect(r.observations[1]).toMatchObject({ label: 'worker/test/a.spec.ts > b', passed: false });
  });

  it('zero tests is an error, never a pass; skipped tests are not assertions', () => {
    expect(regressionResult(META, report([])).status).toBe('error');
    const skipped = regressionResult(META, report([{ title: 'a', status: 'skipped' }, { title: 'b', status: 'pending' }]));
    expect(skipped.status).toBe('error');
    expect(skipped.applicabilityReason).toContain('2 skipped tests');
  });

  it('a test file that failed without a failed test fails the check', () => {
    const r = regressionResult(META, report([{ title: 'a', status: 'passed' }], 'failed'));
    expect(r.status).toBe('failed');
    expect(r.observations).toContainEqual(expect.objectContaining({ label: 'worker/test/a.spec.ts (test file)', passed: false }));
  });

  it('an unreadable report is an error', () => {
    expect(regressionResult(META, { nope: true }).status).toBe('error');
    expect(regressionResult(META, 'PASS').status).toBe('error');
  });
});

describe('pastebin suite selection', () => {
  it('each suite has its own harness digest; the default stays storefront', async () => {
    expect(await harnessDigest()).toBe(await harnessDigest('storefront'));
    expect(await harnessDigest('pastebin')).not.toBe(await harnessDigest('storefront'));
    expect(await harnessDigest('pastebin')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('runs only black-box checks; paste.regression stays in the catalog for applicability', async () => {
    expect(CHECKS_BY_SUITE.pastebin.map((c) => c.id)).toContain('paste.regression');
    expect(blackBoxChecks('pastebin').map((c) => c.id)).toEqual(['paste.roundtrip', 'views.limit', 'views.cache-safety', 'delivery.conditional', 'views.display']);
    const failing: AppTarget = { startFresh: () => Promise.reject(new TypeError('fetch failed')) };
    const list = await runSuite({ suite: 'pastebin', target: failing, capabilities: ['conditional-get'], candidate: CANDIDATE });
    expect(Object.fromEntries(list.map((r) => [r.checkId, r.status]))).toEqual({
      'paste.roundtrip': 'error',
      'views.limit': 'skipped',
      'views.cache-safety': 'skipped',
      'delivery.conditional': 'error',
      'views.display': 'skipped',
    });
    for (const r of list) {
      expect(resultInvariantViolations(r)).toEqual([]);
      expect(r.harnessDigest).toBe(await harnessDigest('pastebin'));
    }
  });

  it('the harness builds the multipart body itself, deterministically', () => {
    const a = multipartBody({ c: 'hello\n', views: '2' });
    expect(a).toEqual(multipartBody({ c: 'hello\n', views: '2' }));
    expect(a.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(a.body).toContain('Content-Disposition: form-data; name="views"\r\n\r\n2\r\n');
    expect(() => multipartBody({ c: 'café' })).toThrow(/unsafe/);
    expect(() => multipartBody({ 'bad name': 'x' })).toThrow(/field name/);
  });
});

describe('pastebin registry entry and fixtures', () => {
  const FEATURE_ROLES: ProjectFixtureRole[] = ['storage', 'api-ui', 'delivery'];

  it('project.json validates and points at the pinned upstream', async () => {
    const manifest = await loadProjectManifest('pastebin');
    expect(manifest.source.commit).toMatch(/^0835cac/);
    expect(manifest.checkSuite).toBe('pastebin');
    const setup = await loadProjectSetupFiles(manifest);
    expect(setup['wrangler.toml']).toContain('name = "pb-converge"');
    expect(setup['wrangler.toml']).toContain('binding = "CF_VERSION_METADATA"');
    expect(setup['wrangler.toml']).not.toContain('custom_domain');
    expect(setup['worker/index.ts']).toContain('X-Converge-Version');
    for (const task of manifest.tasks) {
      for (const id of task.requiredCheckIds) expect(PASTEBIN_CHECKS.map((c) => c.id)).toContain(id);
    }
  });

  it.each(PROJECT_FIXTURE_ROLES)('%s loads and edits no protected path', async (role) => {
    const manifest = await loadProjectManifest('pastebin');
    const patch = await loadProjectFixturePatch(manifest, role);
    expect(patch.summary.length).toBeGreaterThan(0);
    for (const path of Object.keys(patch.files)) expect(isProtectedPath(path, manifest.protectedPaths)).toBe(false);
  });

  it('feature patches stay inside their task paths and own disjoint files', async () => {
    const manifest = await loadProjectManifest('pastebin');
    const owner = new Map<string, string>();
    for (const role of FEATURE_ROLES) {
      const patch = await loadProjectFixturePatch(manifest, role);
      const task = manifest.tasks.find((t) => t.role === role);
      for (const path of Object.keys(patch.files)) {
        expect(matchesAny(task?.editablePaths ?? [], path), `${role} edits ${path}`).toBe(true);
        expect(owner.get(path), `${path} is edited by ${owner.get(path)} and ${role}`).toBeUndefined();
        owner.set(path, role);
      }
    }
  });

  it('intents predict the interaction and the repair resolves it', async () => {
    const manifest = await loadProjectManifest('pastebin');
    const storage = await loadProjectFixturePatch(manifest, 'storage');
    const delivery = await loadProjectFixturePatch(manifest, 'delivery');
    const repair = await loadProjectFixturePatch(manifest, 'repair');
    const change = storage.intent.contractChanges.find((c) => c.key === 'paste.read-side-effects');
    expect(change).toMatchObject({ before: manifest.baselineFacts['paste.read-side-effects'], after: ['none', 'consumes-view'] });
    const assumed = delivery.intent.assumptions.find((a) => a.key === 'paste.read-side-effects');
    if (!assumed || !change) throw new Error('missing intent facts');
    expect(evaluateAssumption(assumed, manifest.baselineFacts['paste.read-side-effects'])).toBe('holds');
    expect(evaluateAssumption(assumed, change.after)).toBe('violated');
    for (const a of repair.intent.assumptions) {
      const after = storage.intent.contractChanges.find((c) => c.key === a.key)?.after;
      expect(evaluateAssumption(a, after), a.key).toBe('holds');
    }
  });

  it('setup files exist for every setupFiles entry', async () => {
    const manifest = await loadProjectManifest('pastebin');
    for (const source of Object.values(manifest.setupFiles)) {
      expect((await readFile(join(PROJECTS_DIR, 'pastebin', source), 'utf8')).length).toBeGreaterThan(0);
    }
  });
});
