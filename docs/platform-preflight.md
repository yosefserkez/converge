# Platform preflight

Date: 2026-10-03. Account: **Hackathon** (`dee95fb76ac07cd6ddd4a1b603e39a22`), Workers Paid. Run `pnpm preflight` to repeat the checks (no paid model calls).

## Service access (verified)

| Service | Result | How it was verified |
|---|---|---|
| Workers Paid, workers.dev | OK, subdomain `converge-42` | `GET /workers/subdomain`; deploys of `converge-dev` and `converge-preview-dev` |
| Artifacts | OK | Namespace `converge-dev` auto-created on first repo create; seed pushed `da9b779`; plain `git clone` with a REST-minted read token returned that commit |
| Containers (`durable_object` policy, beta) | OK | Execution and broker images built (linux/amd64) and pushed by `wrangler deploy`; checks ran in execution containers; broker pushed and merged real commits |
| Workflows | OK | `converge-jobs-dev`; seed, agent, integrate, verify jobs completed; a timed-out step retried and completed |
| R2 | OK | Private bucket `converge-evidence-dev`; evidence written and digest-verified on read |
| Durable Objects (SQLite) | OK | `ProjectCoordinator` migrations applied in the deployed runtime |
| Zero Trust Access | OK | Team `twilight-math-0e95.cloudflareaccess.com`; self-hosted app on the operator host; unauthenticated requests get 302 to login |
| Docker (local image builds) | OK | Docker Engine 29.4.0 (arm64 host, amd64 images via buildx) |
| Model provider | OK | Anthropic key lists `claude-haiku-4-5` (default), `claude-sonnet-5-5`, `claude-opus-5-5` |

## Selected versions (pinned, lockfile committed)

| Package | Version | Note |
|---|---|---|
| wrangler | 4.147.0 | Artifacts types need ≥ 4.145.0; DO-policy local containers need ≥ 4.136.0 |
| @cloudflare/vite-plugin | 1.62.5 | Builds and writes the deploy config redirect |
| @cloudflare/vitest-plugin | 1.3.6 | Replaced `@cloudflare/vitest-pool-workers`; needs vitest ≥ 4.1 |
| vitest | 4.1.11 | Kept on 4.x for the Workers plugin |
| typescript | 6.0.3 | `typescript-eslint` 8.71 supports < 6.1 |
| vite | 8.3.2 | |
| hono | 4.13.12 | |
| zod | 4.6.5 | |
| ai / @ai-sdk/anthropic | 7.0.127 / 4.0.71 | |
| react / react-dom | 19.3.0 | |
| tailwindcss / @tailwindcss/vite | 4.3.3 | |
| @base-ui/react | 1.8.0 | shadcn components on Base UI |
| jose | 6.2.12 | Access JWT verification |
| Container base images | `node:24.21.0-slim@sha256:0e0ff40c…` (execution), `node:24.21.0-trixie-slim` (broker) | multi-arch index; amd64 selected at build |
| git (broker image) | 2.47.3 | Debian trixie package |

## Generated binding types

`apps/control/worker-configuration.d.ts` and `apps/preview/worker-configuration.d.ts` come from `wrangler types`. Relevant generated shapes, used without `any` overrides:

```ts
ARTIFACTS: Artifacts;
PROJECTS: DurableObjectNamespace<import("./worker/index").ProjectCoordinator>;
EXECUTION: DurableObjectNamespace<import("./worker/index").ExecutionContainer>;
GIT_BROKER: DurableObjectNamespace<import("./worker/index").GitBrokerContainer>;
JOBS: Workflow<...JobWorkflow payload...>;
EVIDENCE: R2Bucket;
```

`ArtifactsRepo.createToken()` returns `{ id, plaintext, scope, expiresAt: string (ISO) }`; the create result's `token` is a separate bootstrap credential, which `ArtifactsRepoHost` revokes at once. Tokens are revoked by ID after each operation.

## Minimal verified examples

| Operation | Where | Result |
|---|---|---|
| `ARTIFACTS.create` + revoke bootstrap token | `seed` job | `cv-storefront-b-main` created |
| `repo.createToken('write', 600)` → broker push → revoke by ID | `seed` job | baseline commit `da9b779` on `main` |
| `repo.fork(name, { defaultBranchOnly: true })` + readiness wait | agent and integrate jobs | proposal forks and `cv-ses-…-c-int` integration repo |
| Broker `materialize` at an exact SHA | verify job | source bundle stored in R2, digest-verified |
| Broker `assemble` with an anchor | final candidate | `39b8784` contains the failed pair commit as an ancestor |
| `ctx.container.start({ image: images.workspace, enableInternet: false, instance: 'standard-1' })` + exec + `getTcpPort(8080)` | verify job | 6 protected checks per candidate |
| R2 put/get with digest check | `evidence.ts` | every check result and the validation manifest |
| Workflow step retry | integrate job | a hung assemble step timed out, retried, and completed |

## Platform notes and risks

- **Artifacts billing starts 2026-10-14.** The design does not depend on a free period.
- **The `durable_object` scheduling policy is beta.** Every process in such a container has root capabilities; the design never relies on users or file permissions for isolation.
- **Artifacts has no local simulator.** Local tests use bare Git repositories through the same broker code (see decisions D1).
- **Repo metadata lag.** `lastPushAt` read as `null` right after a push, while `git clone` already returned the commit. Always verify with Git, not metadata.
