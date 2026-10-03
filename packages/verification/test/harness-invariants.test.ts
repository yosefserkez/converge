import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, type Observation } from '@converge/domain';
import { describe, expect, it } from 'vitest';
import {
  type AppInstance,
  type AppTarget,
  buildCheckResult,
  harnessDigest,
  isVerifiedPass,
  readBoundedText,
  resultInvariantViolations,
  runSuite,
} from '../src/index.ts';
import { visibleText } from '../src/checks/checkout-summary.ts';

const CANDIDATE = { candidateId: 'cand-test-1', headSha: 'c'.repeat(40), manifestDigest: `sha256:${'d'.repeat(64)}` };
const DIGEST = `sha256:${'e'.repeat(64)}`;
const pass: Observation = { label: 'x', expected: 1, observed: 1, passed: true };
const fail: Observation = { label: 'y', expected: 1, observed: 2, passed: false };

function result(overrides: { applicable?: boolean; observations?: Observation[]; error?: string }) {
  return buildCheckResult({
    checkId: 'quote.contract',
    candidate: CANDIDATE,
    harnessDigest: DIGEST,
    applicable: overrides.applicable ?? true,
    applicabilityReason: 'test',
    observations: overrides.observations ?? [],
    ...(overrides.error === undefined ? {} : { error: overrides.error }),
    startedAt: 1,
    finishedAt: 2,
  });
}

describe('result invariants', () => {
  it('skipped is never passed and carries no assertions', () => {
    const r = result({ applicable: false, observations: [pass, pass] });
    expect(r).toMatchObject({ status: 'skipped', assertionCount: 0, failedCount: 0, observations: [] });
    expect(isVerifiedPass(r)).toBe(false);
    expect(resultInvariantViolations(r)).toEqual([]);
  });

  it('zero assertions is never passed', () => {
    const r = result({ observations: [] });
    expect(r.status).toBe('error');
    expect(isVerifiedPass(r)).toBe(false);
    expect(resultInvariantViolations(r)).toEqual([]);
  });

  it('a thrown error is never passed, even with passing observations', () => {
    const r = result({ observations: [pass], error: 'TypeError: fetch failed' });
    expect(r.status).toBe('error');
    expect(r.failedCount).toBe(1);
    expect(isVerifiedPass(r)).toBe(false);
  });

  it('any failed assertion fails the check', () => {
    const r = result({ observations: [pass, fail] });
    expect(r).toMatchObject({ status: 'failed', assertionCount: 2, failedCount: 1 });
  });

  it('all passing assertions pass', () => {
    const r = result({ observations: [pass, pass] });
    expect(r).toMatchObject({ status: 'passed', assertionCount: 2, failedCount: 0 });
    expect(isVerifiedPass(r)).toBe(true);
  });

  it('detects forged results', () => {
    const forged = { ...result({ applicable: false }), status: 'passed' as const };
    expect(resultInvariantViolations(forged)).toContain('non-applicable check is not skipped');
    const empty = { ...result({ observations: [] }), status: 'passed' as const, observations: [], assertionCount: 0, failedCount: 0 };
    expect(resultInvariantViolations(empty)).toContain('passed check has zero assertions');
  });
});

class ThrowingTarget implements AppTarget {
  stopped = 0;
  async startFresh(): Promise<AppInstance> {
    return {
      request: async () => {
        throw new TypeError('fetch failed');
      },
      stop: async () => {
        this.stopped += 1;
      },
    };
  }
}

describe('runSuite', () => {
  it('reports transport errors as error, never passed, and stops every instance', async () => {
    const target = new ThrowingTarget();
    let clock = 1000;
    const list = await runSuite({ target, capabilities: ['quote-cache'], candidate: CANDIDATE, now: () => clock++ });
    expect(list.map((r) => r.checkId)).toEqual(CHECKS.map((c) => c.id));
    for (const r of list) {
      expect(resultInvariantViolations(r)).toEqual([]);
      expect(r.status).toBe(r.checkId === 'checkout.summary' ? 'skipped' : 'error');
    }
    expect(target.stopped).toBeGreaterThan(0);
  });

  it('reports a failed start as error', async () => {
    const target: AppTarget = { startFresh: () => Promise.reject(new Error('no readiness')) };
    const list = await runSuite({ target, capabilities: [], candidate: CANDIDATE });
    expect(list.filter((r) => r.applicable).every((r) => r.status === 'error')).toBe(true);
  });

  it('times out a hung check as error', async () => {
    const target: AppTarget = { startFresh: () => new Promise<AppInstance>(() => undefined) };
    const list = await runSuite({ target, capabilities: [], candidate: CANDIDATE, checkTimeoutMs: 50, maxInstances: 10 });
    expect(list.filter((r) => r.applicable).every((r) => r.status === 'error')).toBe(true);
  });

  it('stops instances that finish starting after a check timed out', async () => {
    let stopped = 0;
    const target: AppTarget = {
      startFresh: () =>
        new Promise<AppInstance>((resolve) =>
          setTimeout(
            () =>
              resolve({
                request: () => new Promise(() => undefined),
                stop: async () => {
                  stopped += 1;
                },
              }),
            30,
          ),
        ),
    };
    await runSuite({ target, capabilities: [], candidate: CANDIDATE, checkTimeoutMs: 10, maxInstances: 1 });
    await new Promise((r) => setTimeout(r, 80));
    expect(stopped).toBe(1);
  });

  it('has a stable harness digest', async () => {
    expect(await harnessDigest()).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await harnessDigest()).toBe(await harnessDigest());
  });
});

describe('bounded reads', () => {
  it('truncates large bodies with a label', async () => {
    const body = new Response('x'.repeat(100_000)).body;
    const text = await readBoundedText(body, 1024);
    expect(text.startsWith('x'.repeat(1024))).toBe(true);
    expect(text).toContain('[truncated by verifier: response body exceeded 1024 bytes]');
    expect(text.length).toBeLessThan(1200);
  });

  it('extracts visible text', () => {
    expect(visibleText('<style>.a{}</style><p>List&nbsp;price</p><dd>$1.00</dd>')).toBe('List price $1.00');
  });
});

describe('Workers safety', () => {
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

  async function importClosure(entry: string, seen = new Set<string>()): Promise<Set<string>> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    const source = await readFile(entry, 'utf8');
    for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
      await importClosure(join(dirname(entry), match[1] ?? ''), seen);
    }
    return seen;
  }

  it('index.ts and everything it imports avoid node: built-ins', async () => {
    const files = await importClosure(join(srcDir, 'index.ts'));
    expect(files.size).toBeGreaterThan(5);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect({ file, nodeImport: /from\s+['"]node:|require\(/.test(source) }).toEqual({ file, nodeImport: false });
      expect(file).not.toMatch(/local-target|fixture-patches/);
    }
  });
});
