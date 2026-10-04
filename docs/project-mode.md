# Project mode: real open-source projects

Status: in progress. Requested by the operator on 2026-10-03 for the final demonstration. This expands the first-release scope (the brief excluded arbitrary repository import). It stays narrow: a **curated project registry**, not "import any repository".

## Goal

Connect Converge to a real open-source project, have concurrent agents build a complex feature, verify it, promote the exact approved commit, and see it deployed.

- Project: [SharzyL/pastebin-worker](https://github.com/SharzyL/pastebin-worker) (MIT). A Cloudflare Worker with KV, R2, a cron trigger, static assets, and a React frontend. 21 test files, 156 tests on the Workers Vitest pool and jsdom.
- Feature: view-limited pastes ("burn after N views").
- Deploy: Workers Builds connected to the canonical Artifacts repository. A push to `main` (the guarded promotion) builds and deploys the Worker in the Hackathon account. Converge never holds a deploy token.

## Registry entry (`projects/<slug>/`)

| File | Content |
|---|---|
| `project.json` | Source URL and pinned upstream commit; setup files; runtime commands; protected paths; preset goal and tasks; baseline facts; check suite ID; deploy URL |
| `setup/` | Operator-owned files applied in one setup commit on top of upstream (for example `wrangler.toml` for the Hackathon account). Protected. |
| fixture patches | `fixtures/projects/<slug>/<role>/` like the storefront fixtures |

The registry lives in the Converge repository, so agents cannot change it.

## Pipeline changes

1. **Seed = import + setup commit.** `ARTIFACTS.import()` the pinned upstream into the canonical repository (full history), then the broker commits the setup files on top of `main`. That commit is the session baseline.
2. **Dependency snapshot (trusted prep, once per lockfile).** A prep execution container starts *with* Internet access and no secrets, materializes the baseline, runs the install command from the frozen lockfile, runs the prep build, and calls `snapshotContainer()`. The coordinator records the snapshot ID against the lockfile digest. Candidate containers start from that snapshot with Internet access **off**; the loader replaces source files and keeps `node_modules`. Agents cannot edit the lockfile or package manifests (protected).
3. **Generic runtime image.** Node 24 + pnpm 10 (corepack) + the trusted loader and tool runner. Tools come from `project.json` (typecheck, unit, build, serve), never from agent input.
4. **Protected checks.** Two kinds:
   - *Black-box HTTP checks* in `packages/verification/src/projects/<slug>/`, run by the trusted harness outside the container against the candidate's `wrangler dev` (offline, local KV/R2, fresh `--persist-to` directory per fresh instance). These decide the feature behavior.
   - *Regression suite*: the project's own Vitest suite inside the container, with protected test files. Recorded as in-container evidence (a lower trust level, stated in the UI and threat model).
5. **Deploy verification.** After promotion, Workers Builds deploys `main`. A `deploy-verify` job polls the deployed URL until the deployed version reports the promoted commit (setup commit adds a version header from `CF_VERSION_METADATA`), then runs the black-box checks against production and stores the evidence.

## View-limited pastes: agents and contracts

| Agent | Owns | Objective |
|---|---|---|
| Storage | `worker/storage/**`, `shared/interfaces.ts` | Add `maxViews` and remaining views to paste metadata; consume a view on each content read; delete the paste after the last view |
| API + UI | `worker/handlers/handleWrite.ts`, `shared/uploadPaste.ts`, `shared/parsers.ts`, `frontend/**` (not its build config), `worker/pages/**`, `doc/**`, `scripts/**` | Upload option (`views` form field / `--views`), remaining views on the display page and in metadata responses, docs, CLI |
| Delivery | `worker/handlers/handleRead.ts`, `worker/ssrUtils.ts`, `worker/handlers/handleCors.ts` | Faster reads: strong `ETag`, `If-None-Match` → `304`, longer public caching |

Baseline facts:

```json
{ "paste.read-side-effects": "none", "paste.metadata-fields": ["createdAt","expireAt","sizeBytes","location","filename","highlightLanguage","encryptionScheme","lastModifiedAt"], "paste.cacheability": "public" }
```

Expected interaction: Storage changes `paste.read-side-effects` from `none` to `consumes-view`; Delivery assumes it stays `none` (its 304 path and public caching skip the read). The protected checks then show a limited paste served past its limit (a `304` that does not count, or a publicly cacheable response). The repair makes limited pastes `no-store` and never short-circuits them with `304`, while unlimited pastes keep conditional caching.

## Protected checks (pastebin)

| ID | Applies when | Asserts |
|---|---|---|
| `paste.roundtrip` | always | Upload, read, HEAD, delete; content and status codes unchanged |
| `paste.regression` | always | The project's Vitest suite passes with nonzero tests (in-container evidence) |
| `views.limit` | view-limits | `views=2`: two reads succeed, the third is gone (404); HEAD and metadata reads do not consume views |
| `views.cache-safety` | view-limits | Limited pastes send `Cache-Control: no-store` and never answer `304` |
| `delivery.conditional` | conditional-get | Unlimited pastes send a strong `ETag`; a matching `If-None-Match` gets `304`; public caching stays |
| `views.display` | view-limits-ui | The display page and metadata show the remaining views |

## Limits

- One curated project at a time. Adding a project means a reviewed registry entry and fixture/check work.
- The regression suite runs inside the untrusted container. Its result is evidence, not authority; the black-box checks are the authority.
- Install scripts run in the prep container with Internet access (no secrets). The lockfile pins every package by integrity hash; agents cannot change it.
