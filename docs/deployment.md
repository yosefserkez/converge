# Deployment, rollback, and cleanup

All commands run from the repository root. The scripts read credentials from `.env.local` (gitignored, mode 600) and never print secret values.

## Prerequisites

- A Cloudflare account on **Workers Paid**, with R2 enabled, a workers.dev subdomain, and Zero Trust (Access) set up.
- Docker running locally (Wrangler builds the container images for linux/amd64).
- Node 22.12+ and pnpm 10.
- `.env.local` with:

| Name | Purpose |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Target account. Scripts and Wrangler use only this account. |
| `CLOUDFLARE_API_TOKEN` | Developer token: Workers, Containers, R2, Artifacts, Access edit. Never deployed to the running app. |
| `CONVERGE_OPERATOR_EMAIL` | Operator identity that Access allows. |
| `PREVIEW_SIGNING_KEY_DEV` | ≥ 32 random characters (`openssl rand -base64 48`). |
| `ANTHROPIC_API_KEY` | Optional. Without it live sessions stay disabled. |
| `CF_ACCESS_CLIENT_ID_DEV`, `CF_ACCESS_CLIENT_SECRET_DEV` | Written by `pnpm provision` when it creates the automation service token. |

## Steps (tested on dev, 2026-10-03)

```sh
pnpm install
pnpm preflight                       # toolchain, types, Docker, account services, model listing
pnpm provision --env dev --dry-run   # print the plan
pnpm provision --env dev --apply     # R2 bucket, Access app + policies, service token, config vars
pnpm deploy:dev                      # build, deploy control Worker + images + secrets, deploy gateway
pnpm seed --env dev                  # create the canonical Artifacts repo and push the baseline
pnpm smoke --env dev                 # health, auth, CSRF, gateway checks
pnpm smoke --env dev --fixture-run   # plus a full fixture session (no model calls)
```

`provision` creates or reuses only these resources: the R2 bucket `converge-evidence-<env>`, the Access application for `converge-<env>.<subdomain>.workers.dev`, its operator and automation policies, and the `converge-automation-<env>` service token. It writes the Access issuer, audience, operator subjects, and both origins into `apps/control/wrangler.<env>.jsonc`. Artifacts namespaces appear on first repository create; no namespace command is needed.

`deploy` refuses to continue unless `AUTH_MODE=access`, the Access settings exist, `REPO_HOST=artifacts`, no `VITE_*` variable holds configuration, and the secrets are present. It builds each app with the Cloudflare Vite plugin and deploys the generated output config (`dist/<worker>/wrangler.json`, found through `.wrangler/deploy/config.json`). Secrets go in with `--secrets-file` from a temporary mode-600 file that is deleted right after.

Expected output ends with:

```text
Deployed dev:
  operator: https://converge-dev.<subdomain>.workers.dev
  preview:  https://converge-preview-dev.<subdomain>.workers.dev
  build id: <git sha>
```

## Production

`wrangler.prod.jsonc` mirrors dev with prod names (`converge`, `converge-preview`, `converge-evidence`, namespace `converge`). Before `pnpm deploy:prod`, confirm the account, run `pnpm provision --env prod --apply`, add `PREVIEW_SIGNING_KEY_PROD`, and confirm the spending ceiling (`DEFAULT_MODEL_BUDGET_MICROUSD`). Then run seed and smoke against prod.

## Local development

```sh
cp apps/control/.dev.vars.example apps/control/.dev.vars   # then set ENVIRONMENT=local, AUTH_MODE=local, keys
pnpm dev
```

`.dev.vars` overrides the dev config locally. Artifacts has no local simulator, so seeding fails locally unless you point the binding at the remote service. Unit and integration tests do not need Cloudflare at all.

## Rollback

Redeploy the last known good build:

```sh
git checkout <last-good-sha>
pnpm deploy:dev
```

Or roll back the Worker version in place: `pnpm --filter @converge/control exec wrangler rollback`. SQL migrations are append-only and forward-compatible. Never delete the Durable Object, rewrite canonical Git history, or wipe a namespace as a rollback.

## Fresh demo project

The three-task preset needs the original baseline. After a promotion, canonical main no longer equals that baseline, and the coordinator refuses to start the preset. To record a new run, stop all jobs, change `PROJECT_SLUG` (for example `storefront-2`) in the env config, deploy, and seed. The new slug gets its own coordinator and canonical repository; the old project stays readable through its published replays.

## Cleanup

```sh
pnpm cleanup --env dev --dry-run              # list session repositories that would be deleted
pnpm cleanup --env dev --apply --keep <sessionId>
```

Cleanup deletes only Artifacts repositories whose names match the session pattern (`cv-ses-…-p-…`, `cv-ses-…-c-…`) in this environment's namespace. It always keeps the canonical repository and any session named with `--keep`. It never deletes R2 evidence, approvals, or published replays, and it never issues account-level deletes. Containers stop on their own after their inactivity timeout; jobs destroy their execution containers when they finish.

## Cost controls

- Live sessions require `LIVE_EXECUTION_ENABLED=true`, a provider key, and a per-session model budget no larger than `DEFAULT_MODEL_BUDGET_MICROUSD` (dev: $5).
- The coordinator reserves a conservative maximum before each model request and books ambiguous outcomes as uncertain charges.
- The default model is Claude Haiku 4.5 ($1 / $5 per million tokens).
- Caps: 3 concurrent agents, 8 candidates per session, 2 repairs, 30 turns per agent, 720 s per agent, 2 live previews, 300 s preview lifetime.
- Containers: execution `standard-1` with a 10-minute inactivity timeout and hard timeouts per command; broker `standard-1` with a 10-minute inactivity timeout.
- This application ceiling is not a guarantee about the Cloudflare or Anthropic invoice.

## Beta and platform dependencies

- Containers with the `durable_object` scheduling policy (public beta).
- Artifacts billing starts 2026-10-14.
