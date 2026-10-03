// Trusted protected verification harness. Workers-safe: no node: imports here
// or in any module this file imports. Node-only helpers live in
// ./local-target.ts and ./fixture-patches.ts.
export type { AppInstance, AppRequest, AppResponse, AppTarget, CandidateRef, RunSuiteOptions } from './types.ts';
export { harnessDigest, runSuite } from './suite.ts';
export { buildCheckResult, deriveStatus, isVerifiedPass, resultInvariantViolations } from './result.ts';
export { MAX_RESPONSE_BYTES, readBoundedText, boundString } from './bounded.ts';
export { EXPECTATIONS, HARNESS_VERSION, expectedUnitPrice, formatCents } from './expectations.ts';
export { InstancePool } from './instances.ts';
export { parseFixtureManifest, isProtectedPath, FIXTURE_ROLES, type FixtureManifest, type FixturePatch, type FixtureRole } from './patch-manifest.ts';
