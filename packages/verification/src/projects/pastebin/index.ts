// Pastebin protected checks. Workers-safe: no node: imports here or below.
// The Node-only target lives in ./local-target.ts.
import type { CheckImpl } from '../../checks/context.ts';
import { deliveryConditional, pasteRoundtrip, viewsCacheSafety, viewsDisplay, viewsLimit } from './checks.ts';

/** Implementation for each black-box pastebin check ID. paste.regression is in-container: see regression.ts. */
export const PASTEBIN_CHECK_IMPLEMENTATIONS: Readonly<Record<string, CheckImpl>> = {
  'paste.roundtrip': pasteRoundtrip,
  'views.limit': viewsLimit,
  'views.cache-safety': viewsCacheSafety,
  'delivery.conditional': deliveryConditional,
  'views.display': viewsDisplay,
};

export { PASTEBIN_EXPECTATIONS, PASTEBIN_HARNESS_VERSION } from './expectations.ts';
export { MULTIPART_BOUNDARY, multipartBody } from './client.ts';
export { REGRESSION_CHECK_ID, regressionResult, type RegressionMeta } from './regression.ts';
