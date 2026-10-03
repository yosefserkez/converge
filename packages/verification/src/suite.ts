import { CHECKS, type CheckDefinition, checkApplicability, type CheckResult, type Digest, digestOf } from '@converge/domain';
import { CHECK_IMPLEMENTATIONS } from './checks/index.ts';
import { CHECKOUT_PATTERNS } from './checks/checkout-summary.ts';
import { EXPECTATIONS, HARNESS_VERSION } from './expectations.ts';
import { InstancePool } from './instances.ts';
import { Recorder } from './recorder.ts';
import { buildCheckResult } from './result.ts';
import type { Capability } from '@converge/domain';
import type { RunSuiteOptions } from './types.ts';

const DEFAULT_MAX_INSTANCES = 2;
const DEFAULT_CHECK_TIMEOUT_MS = 60_000;

/** Digest over everything that decides a verdict: version, catalog, and expectations. */
export function harnessDigest(): Promise<Digest> {
  return digestOf({ HARNESS_VERSION, checks: CHECKS, expectations: EXPECTATIONS, checkoutPatterns: CHECKOUT_PATTERNS });
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  // A check that loses the race keeps running until the pool closes; its later
  // rejection must not surface as an unhandled rejection.
  promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface RunCheckArgs {
  def: CheckDefinition;
  capabilities: ReadonlySet<Capability>;
  pool: InstancePool;
  candidate: RunSuiteOptions['candidate'];
  digest: Digest;
  now: () => number;
  timeoutMs: number;
}

async function runCheck({ def, capabilities, pool, candidate, digest, now, timeoutMs }: RunCheckArgs): Promise<CheckResult> {
  const startedAt = now();
  const applicability = checkApplicability(def, capabilities);
  const rec = new Recorder();
  let error: string | undefined;
  if (applicability.applicable) {
    const impl = CHECK_IMPLEMENTATIONS[def.id];
    if (!impl) {
      error = `no harness implementation for check ${def.id}`;
    } else {
      try {
        await withDeadline(impl({ rec, pool, capabilities }), timeoutMs, def.id);
      } catch (err) {
        error = describeError(err);
      }
    }
  }
  return buildCheckResult({
    checkId: def.id,
    candidate,
    harnessDigest: digest,
    applicable: applicability.applicable,
    applicabilityReason: applicability.reason,
    observations: rec.observations,
    ...(error === undefined ? {} : { error }),
    startedAt,
    finishedAt: Math.max(startedAt, now()),
  });
}

/**
 * Runs every catalog check against the candidate over HTTP. The harness builds
 * each CheckResult itself; candidate output never decides a status.
 */
export async function runSuite(opts: RunSuiteOptions): Promise<CheckResult[]> {
  const now = opts.now ?? Date.now;
  const capabilities = new Set(opts.capabilities);
  const pool = new InstancePool(opts.target, opts.maxInstances ?? DEFAULT_MAX_INSTANCES);
  const digest = await harnessDigest();
  const timeoutMs = opts.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  try {
    return await Promise.all(
      CHECKS.map((def) => runCheck({ def, capabilities, pool, candidate: opts.candidate, digest, now, timeoutMs })),
    );
  } finally {
    await pool.close();
  }
}
