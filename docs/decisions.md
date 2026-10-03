# Decisions and deviations

This file records each place where the build differs from the brief, or makes a choice the brief left open. Each entry gives the concrete reason. The product and security invariants stay the same.

## Platform

**D1. Artifacts has no local simulator.** Miniflare marks the binding `DO-NOT-USE-this-resource-will-never-have-a-local-simulator`. So local development cannot exercise Artifacts without a real account. Unit and integration tests use local bare Git repositories through the same broker code, in a test mode that allows `file://` remotes. The deployed environment always uses real Artifacts. The production broker image allows only `https://<account>.artifacts.cloudflare.net/git/<namespace>/<repo>.git` remotes.

**D2. Native Durable Object containers, not the Sandbox SDK.** The brief allows the Sandbox helpers "where useful". The native `ctx.container` API (exec, getTcpPort, destroy) covers every need, so the build does not use the Sandbox SDK or its shim image. The `durable_object` scheduling policy is in public beta. This is an operations risk (see `deployment.md`).

**D3. Declarative `exports`, no legacy `migrations`.** The Wrangler config declares the three SQLite Durable Object classes and the preview entrypoint in `exports`. SQL schema migrations run inside the coordinator (`migrations/*.sql`, checksum-locked, applied whole, never split on semicolons).

**D4. Instance sizes.** Execution containers use `standard-1` (1/2 vCPU, 4 GiB), because `tsc` and esbuild need memory. The broker uses `lite`. The runtime does not accept `basic`.

**D5. The broker has outbound Internet; candidate containers do not.** The broker must reach Artifacts Git over HTTPS. It runs only the broker image (Git plus one bundled server) and never runs candidate code. Execution containers start with `enableInternet: false`.

**D6. A per-start shared secret protects the broker port.** Each broker container start gets a fresh random secret in its environment. The broker DO sends it in `x-converge-broker-auth`. Only that DO can call the broker.

## Data and RPC

**D7. Large or recursive RPC results travel as JSON text.** Workers RPC types reject `unknown` and blow up on recursive JSON types. The coordinator returns snapshots, candidate views, command bodies, job input, and inbox payloads as JSON strings. The Worker passes them through. This also avoids a decode and re-encode.

**D8. DomainError codes cross RPC in the message.** RPC keeps only `Error.message`. `DomainError` messages start with `CODE: `. `asDomainError()` recovers the code. Commands return error envelopes as results (not exceptions), so details survive too. Error results are not stored as idempotency receipts.

**D9. Extra tables (migration 002).** The appendix schema names an evidence registry, intent history, targeted inbox, agent activity, previews, and replays, but does not define them. Migration `002_coordination.sql` adds them, with immutability triggers where records must not change.

**D10. `planKey` excludes the display label.** A label is presentation only and must never become a verification input. Two plans with the same members and anchor have the same key.

## Agents and models

**D11. AI SDK, as the brief requires.** The Claude API guidance prefers the official Anthropic SDK. The brief prescribes the AI SDK with one provider adapter, so the build keeps it (`ai@7`, `@ai-sdk/anthropic@4`).

**D12. Default model `claude-haiku-4-5`, the lowest-cost model that can do the task.** The operator asked for the cheapest workable Anthropic model. Haiku 4.5 costs $1 input and $5 output per million tokens ($0.10 cache read, $1.25 cache write); the snapshot is in `MODEL_PRICE_SNAPSHOT`. `pnpm preflight` checks that the key lists it. Haiku 4.5 rejects the `effort` parameter, so the agent sends `effort` only to newer models. Agents use `toolChoice: 'auto'` (newer models reject forced tool choice). The first live run on 2026-10-03 shows Haiku can do these single-file tasks: all three agents sealed revisions, declared intents that the detector used, and the pricing and caching agents produced the real cross-customer cache bug. Step up to `claude-sonnet-5-5` ($2 / $10) only with evidence that Haiku fails. A refusal ends the turn and the agent reports a blocker.

**D13. Agent workspaces are virtual.** An agent's workspace is a verified source bundle in R2. File tools act on that bundle in the Worker. `run_check` and `request_verification` load the bundle into a fresh, offline execution container. This keeps candidate code away from every secret and makes each turn's checkpoint a content-addressed object.

**D14. `apply_edits` replaces whole files** with an expected prior digest per file. All edits in a call apply or none do. This is simpler and safer to validate than hunk patches.

## Git

**D15. The broker builds trees without a working tree.** It uses a private index and `git merge-tree --write-tree` plus `commit-tree` with two parents. The result is the same native three-way merge and commit shape as `merge --no-ff`, but no checkout happens, so filters, hooks, and symlinks have nothing to act on.

**D16. Candidates live in one integration repository per session** (`cv-<session>-c-int`, a fork of canonical), on branches `candidates/<candidateId>`. Proposal forks are separate repositories. Repairs fork the integration repository, because their base is a failed candidate head.

## Auth and access

**D17. Automation uses an Access service token.** Scripts (`seed`, `smoke`) authenticate with a non-identity Access policy bound to one service token. The Worker accepts the token's `common_name` as the subject only when it is on `OPERATOR_SUBJECTS`. The credentials stay in `.env.local` and go only into request headers.

**D18. Local overrides through `.dev.vars`.** `wrangler.dev.jsonc` holds the deployed dev settings (`AUTH_MODE=access`). `.dev.vars` overrides them locally (`ENVIRONMENT=local`, `AUTH_MODE=local`). The deploy script refuses local auth, and config validation rejects local auth outside `ENVIRONMENT=local`.
