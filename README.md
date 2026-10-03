# Converge

Converge is an intent-aware integration platform for coding agents that work at the same time. Agents declare what they change and what they assume. The platform finds interactions between those claims, merges exact commits, runs protected checks from outside the candidate's container, sends a reproducible failure to a repair agent, and lets a human approve and promote the exact tested commit.

You review a verified result. You do not relay messages between agents.

> Competition prototype for the Cloudflare "Build the next Git platform" challenge. One synthetic TypeScript project. MIT licensed. No real customer data.

## The demonstration

Three agents start from the same storefront baseline:

| Agent | Task |
|---|---|
| Pricing | Give members 20% off. Keep nonmember prices. |
| Caching | Cache unit-price calculations. Keep pricing behavior. |
| Checkout | Show list price, member savings, quantity, unit price, and total. |

Pricing and Caching each pass their own checks and merge with no textual conflict. Together they fail: after a member asks for a quote, a regular customer gets the member's cached price (8000 instead of 10000 cents). Converge predicts this from the declared intents (Pricing changes `unit-price.dimensions`; Caching assumes it is `["productId"]`), confirms it with a protected check, assigns a repair anchored on the exact failed commit, verifies the repaired combination, and promotes only the approved commit.

Three modes are labelled everywhere:

- **Live**: real model calls (Claude Haiku 4.5 by default), real tools, commits, checks, and repairs. Agents may avoid the bug. Converge shows the real outcome.
- **Fixture agents - no model calls**: checked-in patches through the same Artifacts, broker, verification, and promotion machinery. This guarantees the failure and repair for regression tests and as a demo backup.
- **Replay**: read-only playback of a recorded session with its original mode and real timestamps.

## How it works

```text
Control Worker (Hono API + React UI, behind Cloudflare Access)
  -> ProjectCoordinator Durable Object (SQLite; the only domain authority)
  -> JobWorkflow instances (one per job attempt, fenced callbacks)
       - model turns in Worker code (AI SDK + Anthropic)
       - ExecutionContainer: untrusted candidate code, no network, no secrets
       - GitBrokerContainer: trusted native Git, named operations only
       - protected HTTP harness (Worker code, outside the candidate container)
       - Cloudflare Artifacts: canonical repo, proposal forks, integration repo
       - R2: content-addressed evidence
Preview gateway Worker (separate origin): signed expiring previews and public replays
```

Read more: [architecture](docs/architecture.md), [threat model](docs/threat-model.md), [decisions](docs/decisions.md), [platform preflight](docs/platform-preflight.md), [build status](docs/build-status.md).

## Repository layout

```text
apps/control      control Worker (worker/) and operator UI (src/)
apps/preview      preview and replay gateway Worker and replay UI
packages/domain   schemas, canonical hashing, intents, planning, transitions, budget, validation
packages/infrastructure/src/git   trusted Git broker operations
packages/verification             protected harness and fixture patch loader
fixtures/storefront               synthetic project baseline (pushed to Artifacts)
fixtures/deterministic            fixture agents A, B, C and the repair
containers/                       execution and broker images
migrations/                       coordinator SQLite schema
scripts/                          preflight, provision, deploy, seed, smoke, cleanup
docs/                             architecture, decisions, deployment, threat model, demo, status
```

## Quick start (tests only, no Cloudflare account)

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test                 # domain, broker (local bare Git repos), harness (local storefront processes)
```

`pnpm test` runs the deterministic scenario locally: baseline, A, B, and C pass alone; A+B fails customer isolation; A+B+C+R passes; a cache-bypass repair fails `cache.reuse`; a candidate that prints `PASS` changes nothing.

## Deploy to your own account

Requirements: Workers Paid, R2 enabled, a workers.dev subdomain, Zero Trust (Access), Docker, Node 22.12+, pnpm 10. Put credentials in `.env.local` (gitignored); [deployment.md](docs/deployment.md) lists each variable.

```sh
pnpm preflight                        # checks toolchain, types, Docker, account services, model access (no paid calls)
pnpm provision --env dev --dry-run    # shows the plan
pnpm provision --env dev --apply      # R2 bucket, Access app + policies, automation token, config
pnpm deploy:dev                       # builds with the Cloudflare Vite plugin, deploys Worker + images + secrets + gateway
pnpm seed --env dev                   # creates the canonical Artifacts repo and pushes the baseline
pnpm smoke --env dev --fixture-run    # full fixture session on real infrastructure (no model calls)
```

Expected end of the smoke run:

```text
PASS  pricing + caching pair fails customer isolation
PASS  Member pricing passes alone - passed
PASS  Unit-price cache passes alone - passed
PASS  Checkout summary passes alone - passed
PASS  interaction confirmed by evidence and resolved by repair - assumption:resolved
PASS  final anchored candidate is promotable - Full goal + Repair 1 @ <sha>
18/18 checks passed
```

Then open the operator URL, sign in through Access, and start a session. Add `--promote` to the smoke run to approve and promote the final commit (this moves canonical main; see "Fresh demo project" in the deployment guide).

### Live agents and cost

Live sessions need `ANTHROPIC_API_KEY` in `.env.local`, `LIVE_EXECUTION_ENABLED=true`, and a per-session budget no larger than `DEFAULT_MODEL_BUDGET_MICROUSD` ($5 in dev). The coordinator reserves a conservative maximum before each model call, settles real usage after it, and books ambiguous outcomes as uncertain charges. The default model is Claude Haiku 4.5 ($1 / $5 per million tokens). This application ceiling is not a guarantee about your Cloudflare or Anthropic invoice.

### Clean up

```sh
pnpm cleanup --env dev --dry-run
pnpm cleanup --env dev --apply --keep <sessionId-to-retain>
```

Cleanup deletes only this project's session repositories. It keeps the canonical repository, evidence, approvals, and published replays.

## Platform dependencies

- Cloudflare Containers with the `durable_object` scheduling policy (public beta).
- Cloudflare Artifacts (Workers Paid; billing starts 2026-10-14). Artifacts has no local simulator.
- Wrangler 4.147.0 (Artifacts types need 4.145.0 or later).

## Limits

The protected checks are evidence of specified behavior, not a proof against a deliberately adversarial implementation. One active mutating session per project. The `X-Demo-Customer` header selects a synthetic identity and is not an authentication pattern. "Promoted" means canonical main points to the approved commit; it does not deploy an application.

## License

[MIT](LICENSE)
