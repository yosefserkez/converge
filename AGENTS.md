# Guide for coding agents in this repository

Read `README.md` and `docs/architecture.md` first. Keep these rules.

## Invariants (do not weaken)

- The coordinator Durable Object is the only domain authority. Workflows, R2, and Git are not.
- Every workflow callback sends job, attempt, and fence. Never accept a stale fence.
- Candidate code runs only in execution containers with no network and no secrets. Never pass a provider key, Cloudflare token, or Artifacts token into one.
- The Git broker runs named operations only. Never add a shell or arbitrary-command endpoint. Never run candidate code in it.
- The protected harness runs outside candidate containers and builds results itself. Candidate output is data, never evidence.
- A skipped check is not a pass. A zero-assertion check is not a pass. Prior failures stay visible.
- Approval pins one exact head and validation digest. Promotion pushes that exact commit with an ancestry proof and an explicit lease. Never squash, rebase, or re-merge after approval.
- Candidates of registry projects restore the dependency snapshot with Internet off. Only the prep container installs, with Internet and no secrets.
- The production check after deploy is evidence. Never let it change `main` or roll back on its own.
- Never fabricate model calls, commits, test results, costs, or URLs. Label live, fixture, and replay modes truthfully.

## Working rules

- Strict TypeScript. Zod at every untrusted boundary. No `any` in source.
- Money is integer micro-USD. Time is UTC epoch milliseconds. Digests are `sha256:<hex>`; Git object IDs are separate.
- Hash with `canonicalJson` / `digestOf` only.
- RPC results that are large or recursive travel as JSON text (see `docs/decisions.md` D7).
- Schema changes go in a new numbered file in `migrations/`. Never edit an applied migration.
- Copy in the UI, docs, code comments, and commit messages follows ASD-STE100 (short sentences, active voice, plain words).
- Commit messages carry no AI attribution trailers.
- A registry project lives in `projects/<slug>/`. Setup files and upstream tests are protected paths; list upstream tests one by one so agent test folders stay editable.

## Commands

```sh
pnpm typecheck
pnpm lint
pnpm test                                      # unit: domain, broker, harness
pnpm --filter @converge/control test:workers   # coordinator in the Workers runtime
pnpm test:e2e                                  # browser checks
```

Run only the tests your change touches while you work; run the full set before you commit.
