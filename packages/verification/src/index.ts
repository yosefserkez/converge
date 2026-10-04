// Trusted protected verification harness. Workers-safe: no node: imports here
// or in any module this file imports. Node-only helpers live in
// ./local-target.ts and ./fixture-patches.ts.
export type { AppInstance, AppRequest, AppResponse, AppTarget, CandidateRef, RunSuiteOptions } from './types.ts';
export { blackBoxChecks, harnessDigest, runSuite } from './suite.ts';
export { CHECKS_BY_SUITE, CHECK_SUITES, type CheckSuiteId } from '@converge/domain';
export {
  MULTIPART_BOUNDARY,
  multipartBody,
  PASTEBIN_EXPECTATIONS,
  PASTEBIN_HARNESS_VERSION,
  REGRESSION_CHECK_ID,
  regressionResult,
  type RegressionMeta,
} from './projects/pastebin/index.ts';
export { buildCheckResult, deriveStatus, isVerifiedPass, resultInvariantViolations } from './result.ts';
export { MAX_RESPONSE_BYTES, readBoundedText, boundString } from './bounded.ts';
export { EXPECTATIONS, HARNESS_VERSION, expectedUnitPrice, formatCents } from './expectations.ts';
export { InstancePool } from './instances.ts';
export { parseFixtureManifest, isProtectedPath, FIXTURE_ROLES, type FixtureManifest, type FixturePatch, type FixtureRole } from './patch-manifest.ts';
export {
  assembleProjectFixturePatch,
  parseProjectFixtureManifest,
  PROJECT_FIXTURE_ROLES,
  type ProjectFixtureManifest,
  type ProjectFixturePatch,
  type ProjectFixtureRole,
} from './patch-manifest.ts';
