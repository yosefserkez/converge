# Build status

Last update: 2026-10-03. This file records completed work, actual test outcomes, current blockers, and the next step. It states only what was run.

## Deployed (dev)

| Item | Value |
|---|---|
| Operator host (Access-protected) | https://converge-dev.converge-42.workers.dev |
| Preview and replay host | https://converge-preview-dev.converge-42.workers.dev |
| Canonical repository | `cv-storefront-b-main` in Artifacts namespace `converge-dev`, main `da9b77933f99a71882b08acdb61211ff6d04144f` (baseline) |
| Public replay (fixture run) | https://converge-preview-dev.converge-42.workers.dev/replay/rpl_x6sgkwykc5ujbdgib32rjco54u |

## Phase gates

| Phase | State | Evidence |
|---|---|---|
| 0. Access, versions, skeleton | Done | `pnpm preflight`: 17/17; `docs/platform-preflight.md` |
| 1. Real infrastructure slice | Done | Seed job created the Artifacts repo and pushed the baseline through the broker container; independent `git clone` confirmed `da9b779` |
| 2. Deterministic end-to-end loop | Done on deployed infra | `pnpm smoke --env dev --fixture-run`: 18/18 (`docs/runs/2026-10-03-dev-fixture-smoke.log`) |
| 3. Live agents | In progress | First live run found a tool-result bug (fixed, deployed); retry running |
| 4. Review and promotion | Built, not yet run on deployed infra | Broker lease tests pass locally; deployed promotion pending |
| 5. Interface and isolated demonstration | In progress | UI being built; gateway, capability checks, and replay publication verified |
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
| Coordinator in Workers runtime | `pnpm --filter @converge/control test:workers` | being written |
| Browser (Playwright, agent-browser) | | not yet run |

## Blockers

None external. The account, Artifacts, Containers, Access, and the model key all work.

## Next steps

1. Finish the live run; capture overlapping agent activity as evidence.
2. Run a fresh fixture session and promote its final candidate; confirm main equals the approved commit.
3. Merge the UI and the coordinator runtime tests; run browser checks at desktop and mobile widths.
4. Fault tests, README, demo script, submission checklist, production deploy.
