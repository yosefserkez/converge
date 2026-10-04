import {
  CHECKS,
  CHECKS_BY_SUITE,
  type CheckDefinition,
  checkApplicability,
  type CheckResult,
  type CheckSuiteId,
  type Digest,
  digestOf,
  PASTEBIN_CHECKS,
} from '@converge/domain';
import { CHECK_IMPLEMENTATIONS } from './checks/index.ts';
import type { CheckImpl } from './checks/context.ts';
import { CHECKOUT_PATTERNS } from './checks/checkout-summary.ts';
import { EXPECTATIONS, HARNESS_VERSION } from './expectations.ts';
import { PASTEBIN_CHECK_IMPLEMENTATIONS, PASTEBIN_EXPECTATIONS, PASTEBIN_HARNESS_VERSION } from './projects/pastebin/index.ts';
import { InstancePool } from './instances.ts';
import { Recorder } from './recorder.ts';
import { buildCheckResult } from './result.ts';
import type { Capability } from '@converge/domain';
import type { RunSuiteOptions } from './types.ts';

const DEFAULT_MAX_INSTANCES = 2;
const DEFAULT_CHECK_TIMEOUT_MS = 60_000;

/** Implementations per suite. In-container checks (for example paste.regression) have none here. */
const IMPLEMENTATIONS: Readonly<Record<CheckSuiteId, Readonly<Record<string, CheckImpl>>>> = {
  storefront: CHECK_IMPLEMENTATIONS,
  pastebin: PASTEBIN_CHECK_IMPLEMENTATIONS,
};

/**
 * Digest over everything that decides a verdict in one suite: version, catalog,
 * and expectations. Each suite has its own digest. The storefront input is
 * unchanged, so storefront digests stay the same.
 */
export function harnessDigest(suite: CheckSuiteId = 'storefront'): Promise<Digest> {
  switch (suite) {
    case 'storefront':
      return digestOf({ HARNESS_VERSION, checks: CHECKS, expectations: EXPECTATIONS, checkoutPatterns: CHECKOUT_PATTERNS });
    case 'pastebin':
      return digestOf({ HARNESS_VERSION: PASTEBIN_HARNESS_VERSION, checks: PASTEBIN_CHECKS, expectations: PASTEBIN_EXPECTATIONS });
  }
}

/** The checks that the harness runs over HTTP: every catalog check except in-container ones. */
export function blackBoxChecks(suite: CheckSuiteId): readonly CheckDefinition[] {
  return CHECKS_BY_SUITE[suite].filter((def) => (def.evidence ?? 'black-box') === 'black-box');
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
  implementations: Readonly<Record<string, CheckImpl>>;
  capabilities: ReadonlySet<Capability>;
  pool: InstancePool;
  candidate: RunSuiteOptions['candidate'];
  digest: Digest;
  now: () => number;
  timeoutMs: number;
}

async function runCheck({ def, implementations, capabilities, pool, candidate, digest, now, timeoutMs }: RunCheckArgs): Promise<CheckResult> {
  const startedAt = now();
  const applicability = checkApplicability(def, capabilities);
  const rec = new Recorder();
  let error: string | undefined;
  if (applicability.applicable) {
    const impl = implementations[def.id];
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
 * Runs every black-box check of the selected suite (default storefront)
 * against the candidate over HTTP. The harness builds each CheckResult itself;
 * candidate output never decides a status.
 */
export async function runSuite(opts: RunSuiteOptions): Promise<CheckResult[]> {
  const suite = opts.suite ?? 'storefront';
  const now = opts.now ?? Date.now;
  const capabilities = new Set(opts.capabilities);
  const pool = new InstancePool(opts.target, opts.maxInstances ?? DEFAULT_MAX_INSTANCES);
  const digest = await harnessDigest(suite);
  const timeoutMs = opts.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const implementations = IMPLEMENTATIONS[suite];
  try {
    return await Promise.all(
      blackBoxChecks(suite).map((def) =>
        runCheck({ def, implementations, capabilities, pool, candidate: opts.candidate, digest, now, timeoutMs }),
      ),
    );
  } finally {
    await pool.close();
  }
}
