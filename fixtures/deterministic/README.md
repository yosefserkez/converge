# Deterministic fixture patches

Fixture agents - no model calls.

These directories hold checked-in changes for the deterministic demo mode and
for regression tests. They guarantee the failure and repair scenario. They are
not evidence of live model concurrency.

| Directory | Task | Change |
|---|---|---|
| `pricing/` | A, `task-pricing` | Members get 20% off. Unit price now depends on `productId` and `membershipTier`. |
| `caching/` | B, `task-caching` | Unit-price cache keyed by `productId` only. Correct against the baseline. |
| `checkout/` | C, `task-checkout` | Accessible price breakdown from the existing quote response. |
| `repair/` | R, repair of A+B | Cache key includes `productId` and `membershipTier`. The cache stays active. |

Each `manifest.json` has:

- `role` and `taskId`: the preset task the patch belongs to.
- `files`: repository path to patch file path, relative to the patch directory.
  Each patch file is a full replacement of the repository file, not a diff.
- `intent`: a `ChangeIntent` that matches `packages/domain/src/schemas.ts`.
  `dependencyRevisionIds` is empty. The controller fills in real revision IDs.
- `summary`: the text the fixture agent reports when it finishes.

Apply `repair/` on top of the combined A+B+C content. It changes only
`src/pricing/quote-cache.ts` and `tests/quote-cache.test.ts`.

Expected protected results (see `packages/verification/test`):

- Baseline, A, B, and C each pass all applicable checks.
- A+B fails `pricing.isolation`: after `member-1` requests a backpack,
  `regular-1` receives the cached member price of 8000 cents instead of 10000.
- A+B+C+R passes every check, and `cache.reuse` proves the cache is still active.

Load a patch with `loadFixturePatch(role)` from
`@converge/verification/fixture-patches`.
