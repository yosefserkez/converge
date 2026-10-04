# Build status

Last update: 2026-10-04. This file records completed work, actual test outcomes, current blockers, and the next step. It states only what was run.

## Deployed (dev)

| Item | Value |
|---|---|
| Operator host (Access-protected) | https://converge-dev.converge-42.workers.dev |
| Preview and replay host | https://converge-preview-dev.converge-42.workers.dev |
| Project | `pastebin-2` (`PROJECT_KIND=pastebin`, setup v2 with the `VIEW_COUNTER` Durable Object); canonical repo `cv-pastebin-2-b-main`, main `027db44` (baseline, 156/156 upstream tests). No active session |
| Earlier pastebin project | `pastebin-1`: canonical main `93a80f0` (live run, KV view count), deployed to pb-converge |
| Deployed project | https://pb-converge.converge-42.workers.dev, version `93a80f0f682f` (feature with the KV consistency gap). The `VIEW_COUNTER` migration is not deployed yet |
| Pastebin fixture run | `ses_md2fn53dbtnf53567dmdqibyff`: repair candidate `9e599e0` passed all six checks (cancelled to free the project for the live run) |
| Pastebin production check | Promoted `93a80f0` (deployed by `wrangler deploy --tag` until Workers Builds is connected). Deploy observer: version matched, `views.limit` and `views.cache-safety` **failed in production** (KV eventual consistency). See `docs/project-mode.md` |
| Pastebin live run (Haiku 4.5) | `ses_frsuscfxw3clnpabyfbd5hssx2` ready. Storage + Conditional reads failed `views.cache-safety`; Repair 1 fixed it; Repair 2 fixed `views.display`. Candidate `93a80f0f68` passed all six checks. Model spend about $1.90 |
| Earlier storefront project | `cv-storefront-b-main`, main `a663afc` (promoted from the live run) |
| Public replay (fixture run) | https://converge-preview-dev.converge-42.workers.dev/replay/rpl_x6sgkwykc5ujbdgib32rjco54u |
| Public replay (live run) | https://converge-preview-dev.converge-42.workers.dev/replay/rpl_suwonabsqmruq2gq6pvnctj2vq |

## Deployed (prod)

| Item | Value |
|---|---|
| Operator host (Access-protected) | https://converge.converge-42.workers.dev |
| Preview and replay host | https://converge-preview.converge-42.workers.dev |
| Canonical repository | `cv-storefront-b-main` in namespace `converge`, main `da9b779` (baseline) |
| Smoke | `pnpm smoke --env prod --fixture-run`: 18/18 (build `3f98cf3`) |
| Demo-ready session | `ses_qgjsnsuhtkhp6jjhysa42gsjpu` in `ready`; promotable candidate `77106112a3d3c95cf38da06fa9002faa1ddbdfcc` (left unpromoted for the recording) |

## Phase gates

| Phase | State | Evidence |
|---|---|---|
| 0. Access, versions, skeleton | Done | `pnpm preflight`: 17/17; `docs/platform-preflight.md` |
| 1. Real infrastructure slice | Done | Seed job created the Artifacts repo and pushed the baseline through the broker container; independent `git clone` confirmed `da9b779` |
| 2. Deterministic end-to-end loop | Done on deployed infra | `pnpm smoke --env dev --fixture-run`: 18/18 (`docs/runs/2026-10-03-dev-fixture-smoke.log`) |
| 3. Live agents | Done | Live run `ses_spukrzguxi3dnyna2gs3vzeg5u` (Haiku 4.5): three agents overlapped (113 s with 2+ busy, 17 s with all 3); predicted interactions from real intents; real counterexample; live repair; `docs/runs/2026-10-03-dev-live-run.md` |
| 4. Review and promotion | Done | Approved and promoted `a663afc`; `git clone` shows main equals the approved commit, with the failed anchor `5f6b438` as an ancestor |
| 5. Interface and isolated demonstration | Done | UI being built. Verified on dev: preview of `a663afc` built and served through the gateway (CSP, no-referrer; member 8000 then regular 10000 in one process); diagnostics 404, PUT 405, injected price field 422, tampered capability 403; public replays served anonymously |
| 6. Hardening and handoff | Not started | |

## Deployed fixture run (session `ses_jlxedxge73v2zho4h64wudjodm`, fixture agents, no model calls)

| Candidate | State | Head | Notes |
|---|---|---|---|
| Baseline | passed | `da9b779` | cache and checkout checks not applicable |
| Member pricing | passed | `1f0e809` | |
| Unit-price cache | passed | `8c19538` | its first assemble step hung, timed out, retried, completed |
| Checkout summary | passed | `aa6a5a0` | |
| Member pricing + Unit-price cache | **failed** | `dd2addc` | `pricing.isolation`: regular customer got 8000 instead of 10000 |
| Member pricing + Unit-price cache + Checkout summary | **failed** | `c2e1546` | same counterexample |
| Full goal + Repair 1 | passed, promotable | `39b8784` | anchored on `dd2addc`; interaction resolved |

The session was cancelled (not promoted) so the live run could use the preset baseline.

## Tests actually run

| Suite | Command | Result |
|---|---|---|
| Unit (domain, broker, harness) | `pnpm test` | 233 passed (domain 148, broker 51, verification 34). One broker test timed out once under parallel load; per-file timeout raised to 30 s; 6 later runs passed |
| Typecheck | `pnpm -r typecheck` | all 6 packages pass |
| Lint | `pnpm lint` | pass |
| Deployed smoke | `pnpm smoke --env dev --fixture-run` | 18/18 |
| Coordinator in Workers runtime | `pnpm --filter @converge/control test:workers` | 12 passed (schema, idempotency, seed, fencing, budget, full orchestration to promotion, restart) |
| Security | `pnpm vitest run --project unit tests/faults` | 14 passed (Access JWT, CSRF, capabilities, redaction, config) |
| Local pipeline integration | `pnpm vitest run --project integration` | 5 passed (real broker over bare repos + protected harness; failing pair, anchored repair, lease-guarded promotion, stale promotion refused) |
| Browser (Playwright, deployed dev) | `pnpm test:e2e` | 27 passed, 3 skipped (opt-in full flow, keyboard on mobile). Found and fixed: phone menu closed at once, skip link did not move focus, long contract values overflowed the replay, preview iframe blank (sandbox origin and 64 KiB asset cut-off) |
| Browser (agent-browser, deployed dev) | manual | Full operator flow in the UI: create, start, review, approve, promote, preview, publish replay |

## Blockers

- Workers Builds for `pb-converge` must be connected in the dashboard (needs a user-scoped token). See `docs/project-mode.md`.

## Open items

- An assemble call hung twice on the first candidate of a session and recovered by step retry. Broker calls now time out after 180 s and log one line each; the root cause is not yet known.
- Command receipts are written after the command's transaction. `createSession` and `approve` derive their record IDs from the idempotency key, so a re-run after a crash returns the same record (tested). Other commands are naturally idempotent or create only bounded extra rows (a second preview).
- The live replay published before the readable-explanation fix shows proposal IDs in interaction explanations.

## Next steps

1. Run a live session on `pastebin-2` (Durable Object view count): `node --experimental-strip-types scripts/dev/session.ts live 5`. Retry turn-limit blocks with `scripts/dev/retry.ts <session>`. The last attempt `ses_f5qabg373rymgyv6dlqy6d6yfw` was cancelled at wrap-up ($1.78 spent; Conditional reads sealed).
2. Promote, deploy (`wrangler deploy --tag <12-char sha>` until Workers Builds is connected to `cv-pastebin-2-b-main`), and confirm `deploy.verified`.
3. Update the pastebin fixture patches to use the Durable Object view count (they still use KV).
4. Publish the source repository (needs your approval of host and visibility); record the video.
