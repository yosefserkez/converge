# Architecture

Converge is an intent-aware integration platform for coding agents that work at the same time. Its unit of work is a change proposal with declared assumptions and immutable evidence. It is not a chat transcript or a list of pull requests.

## The loop

```text
Operator sets the goal (frozen preset task set, baseline, budget)
  -> agents declare ChangeIntents and edit isolated workspaces at the same time
  -> the coordinator compares declared facts and assumptions (deterministic rules)
  -> the broker seals each proposal as a real commit in its own Artifacts fork
  -> the coordinator plans exact candidates: baseline, standalones, highest-risk pair, full goal
  -> the broker merges exact heads (native three-way merge) into the integration repo
  -> the trusted harness checks each candidate over HTTP from outside its container
  -> a combined failure that each member passed alone confirms the interaction
  -> a repair proposal is anchored on the exact failed candidate and depends on its revisions
  -> the final candidate reuses the failed commit as its anchor and merges the rest
  -> the operator approves the exact tested commit and its validation digest
  -> the broker promotes that commit with an ancestry proof and an explicit lease
```

## Components

```text
Operator browser
    |  Cloudflare Access (JWT verified in the Worker)
    v
Control Worker (Hono API + React SPA assets)          apps/control/worker/index.ts
    |
    v
ProjectCoordinator Durable Object (SQLite)            apps/control/worker/coordinator/
    |  commands + transactional outbox + alarm
    v
JobWorkflow (one instance per job attempt)            apps/control/worker/workflow.ts, jobs/*
    |-- model turns in Worker context (AI SDK, Anthropic)       jobs/live-agent.ts
    |-- ExecutionContainer DO: untrusted code, no network       execution-container.ts
    |-- GitBrokerContainer DO: trusted Git, named operations    git-broker-container.ts, containers/git-broker/
    |-- protected harness (Worker code)                         packages/verification
    |-- Artifacts: canonical repo, proposal forks, integration  artifacts.ts
    `-- R2: content-addressed evidence and checkpoints          evidence.ts

Preview gateway Worker (separate origin)              apps/preview/src/worker.ts
    -> PreviewEntrypoint (service binding, restricted)          preview-entrypoint.ts
    -> signed, expiring, candidate-scoped capability            capability.ts
    -> the candidate's isolated preview container
```

## One domain authority

The coordinator owns project, session, proposal, revision, candidate, check, interaction, approval, promotion, job, budget, and event state in one SQLite database (`migrations/`). Workflow state is not business truth. R2 holds bytes addressed by digest. Git holds source snapshots, not policy.

Each command validates input, then commits the state change, its event, its request receipt, and any outbox rows in one transaction. The coordinator arms its alarm before the transaction, so a committed outbox row always gets dispatched. A once-per-minute cron calls `recover()` to dispatch due work, expire stale leases whose workflow stopped, and expire previews. A duplicate trigger is harmless.

Long work (Git, model calls, tests, HTTP) never runs inside a SQL transaction.

## Jobs, attempts, and fences

`createJob` allocates attempt 1 with fence 1 and queues an outbox dispatch. The workflow instance ID is `<job>-a<attempt>`. The first workflow step leases the attempt; every later callback sends job and fence. Cancellation bumps the fence first, so a late callback from the old attempt gets `STALE_FENCE` and changes nothing. A retry is a new attempt with a larger fence and a fresh deadline of the same length as the first, so a late retry does not expire at lease. Billing reconciliation from an old attempt is still recorded, because spend is a fact even when the domain result is stale.

## Candidates and repairs

A `CandidatePlan` holds exact sealed revisions in deterministic topological order (task ordinal, then revision ID) and, for repairs, an anchor: the failed candidate's exact head and members. The plan key is the digest of the plan without its display label. A new revision never changes an existing candidate; it creates a new plan.

A repair proposal starts from the failed candidate's head, in a fork of the integration repository, and depends on that candidate's exact revisions. The final candidate starts from the anchor commit and merges only the members the anchor does not already contain. This keeps ancestry and never re-creates an equivalent but different anchor.

## Verification and evidence

Applicability comes from the controller-assigned capabilities of a candidate's members, never from agent metadata. Each check result names the candidate head, manifest digest, and harness digest, and carries assertion counts and expected and observed values. The harness writes each result to R2 before the coordinator records the reference. A validation manifest exists only when every applicable check passed with nonzero assertions and stored evidence. Approval re-reads and re-hashes that evidence.

## Interaction detection

Agents declare facts they change (`contractChanges`) and facts they assume (`assumptions` with `eq`, `subset_of`, or `contains`). For each change, the detector evaluates other proposals' assumptions on the same key against the new value. A violated assumption is a predicted interaction; a missing or contested fact is `unknown`. Two different new values for one fact are a shared-write interaction and are never resolved by order. File overlap is a separate signal. The rules are generic over keys; nothing names the pricing or caching agents.

A prediction becomes `confirmed` only when a combined candidate fails a protected check that each member passed alone. It becomes `resolved` only when a later candidate with the same proposals passes that check.

## Agents

Three agent jobs run as independent workflow instances with separate contexts and workspaces. Each durable step is one model turn: reserve budget, call the model, settle usage, run the requested tools one at a time, and checkpoint the workspace bundle and provider messages to R2. A workspace is a verified source bundle; file tools act on it in the Worker, and checks load it into a fresh offline execution container. Fixture agents apply checked-in patches through the same seal and verification pipeline and are labelled "Fixture agents - no model calls".

Each model call marks its last message as a prompt-cache breakpoint (on a copy, so stored history never collects breakpoints). Later turns read the system prompt, tools, and history from the cache. The ledger prices cache reads and writes separately. After each turn, the coordinator stores the agent state (evidence references and counters) per proposal. A new attempt for the same proposal and base continues from that state with a fresh turn budget, so the turn limit does not throw away work.

## Project mode

A registry entry (`projects/<slug>/project.json`) gives the source URL and pinned commit, setup files, runtime commands, protected paths, tasks, baseline facts, the check suite, and the deploy URL. `apps/control/worker/projects.ts` loads every entry at build time. `PROJECT_KIND` selects one.

- **Seed:** `ARTIFACTS.import()` takes the upstream default branch. The broker then creates `main` as one deterministic setup commit on the pinned commit.
- **Dependency snapshot:** a prep execution container with Internet and no secrets installs from the frozen lockfile, runs the prep build, and calls `snapshotContainer()`. The coordinator stores the snapshot ID. Each agent and verify job first configures its execution container with that snapshot, and candidates restore it with Internet off.
- **Bundles:** text files carry `utf8`; binary files carry `base64`. Imported projects use larger materialize bounds (1 MiB per file, 16 MiB in total).
- **Verification:** the black-box suite runs against the candidate's `wrangler dev` from outside the container. The project's own Vitest suite runs inside it and becomes `paste.regression`, recorded as in-container evidence.
- **Deploy observation:** after a successful promotion, the promote job reads `X-Converge-Version` from the deploy URL until it matches the promoted commit (40 polls, 15 s apart). Then it runs the protected checks against production. The coordinator records `deploy.verified`, `deploy.version-mismatch`, or `deploy.checks-failed` with evidence. This is evidence only; the guarded push already decided `main`.
- **Previews:** not available. The project's absolute asset paths break under the preview prefix.

The git broker stores the image it started with. When a deploy ships a new broker image, the next operation replaces the running container.

## Previews and replays

An operator allocates a preview for a materialized candidate. The coordinator records it with a nonce and absolute expiry; the Worker signs a capability over its canonical JSON. The gateway verifies it and asks the restricted entrypoint to forward the request. The first request starts the candidate app in a preview container; later requests cannot restart an expired preview or extend it.

A published replay is a whitelist transformation of a settled session (`replay.ts`), stored under `public/replays/` in R2 and served read-only by the gateway.
