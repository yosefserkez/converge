# Threat model

Converge is a competition prototype for one synthetic project. This document lists the assets, the trust zones, the controls that are in place, and the limits. It does not claim multi-tenant certification or universal containment of malicious code.

## Assets

| Asset | Where it lives | Who may use it |
|---|---|---|
| Anthropic API key | Control Worker secret | Model calls in Worker code only |
| Preview signing key | Control Worker secret | Sign and verify preview capabilities |
| Artifacts repository tokens | Minted per operation, held in memory | Git broker process, for one operation |
| Cloudflare API token, Access service token | Developer machine (`.env.local`, gitignored) | Deploy and automation scripts |
| Canonical `main` | Artifacts canonical repository | Guarded promotion only |
| Evidence (sources, checks, diffs, logs) | Private R2 bucket, content-addressed | Coordinator and authenticated operator |
| Approvals | Coordinator SQLite, immutable rows | Verified operator identity |

## Trust zones

1. **Operator browser → control Worker.** Cloudflare Access protects the host. The Worker verifies the signed `Cf-Access-Jwt-Assertion` (issuer, audience, current keys, expiry) and checks the subject against `OPERATOR_SUBJECTS`. It never trusts header presence or an email header. Mutations need an allowed `Origin`, a JSON body, and an `Idempotency-Key` header, which forces a CORS preflight that the API never grants cross-origin.
2. **Control Worker and coordinator (trusted).** They hold the provider key and run the protected harness. The coordinator is the only domain authority. Every workflow callback carries job, attempt, and fence, and the coordinator rejects stale attempts.
3. **Git broker container (trusted Git zone).** It accepts named operations only. It runs `git` with argv arrays, a controlled environment, hooks disabled, no global or system config, redirects disabled, and a remote allowlist. Credentials go into `GIT_CONFIG_*` environment entries of each child process, never into argv, URLs, logs, or results. It never runs candidate code, package scripts, or dependency installs. A fresh per-start secret protects its port.
4. **Execution containers (untrusted).** Candidate code runs here with no Internet access and no secrets. Results from inside (stdout, files, exit codes) are data, not authority. The harness talks to the app from outside over the fixed private port and builds every check result itself. A hard timeout destroys the whole container, so child processes cannot keep running.
5. **Preview gateway (public, separate origin).** It reaches the control plane only through the `PreviewEntrypoint` service binding, which resolves already-allocated previews and published replays. It cannot create sessions, call models, approve, or promote. It verifies the HMAC capability, expiry, candidate, and nonce. It strips cookies, Access headers, and authorization; forwards only `GET` and `POST /api/quote` with a narrow body; blocks `/__*` diagnostic paths; and drops `Set-Cookie`, redirects, and service-worker headers from responses. It applies a restrictive CSP, `no-referrer`, and `no-store`.
6. **Models.** Prompts, files, tool output, and peer messages are untrusted text. Tool authorization is enforced in code: edits must match the task's editable paths and avoid protected paths, and each edit must name the prior digest. No tool can approve, promote, read secrets, fetch arbitrary URLs, or run a shell.

## Controls against specific attacks

| Attack | Control |
|---|---|
| Candidate code reads Git or provider credentials | Execution containers receive no secrets and no network. Tokens exist only in the broker process for one operation. |
| Candidate forges a passing result (prints `PASS`, writes `results.json`, edits tests) | The harness runs outside the container, builds results itself, and hashes them into R2. Protected tests are not in the editable paths. A test shows a `PASS`-printing server changes nothing. |
| Edit to a protected file or outside scope | The tool layer refuses it; the broker refuses it again (`PROTECTED_PATH`, `OUT_OF_SCOPE_EDIT`); the coordinator re-checks the sealed diff. |
| Path traversal, symlinks, submodules, oversize files | Path schema rejects `..`, absolute paths, and `.git`. The broker rejects symlink and submodule modes and enforces size limits. The bundle loader verifies each file digest and refuses traversal. |
| Shell or argument injection | No shell anywhere: argv arrays for Git and container exec; branch names, SHAs, and paths are validated. |
| Stale or replayed callback | Fencing tokens; lease checks; `STALE_FENCE` errors; idempotent receipts with body digests. |
| Promotion overwrites someone else's work | Ancestry proof plus `git push --force-with-lease=refs/heads/main:<expected>` of the exact approved SHA; reconciliation never pushes twice and never rolls back. |
| Approval of a different commit than reviewed | Approval pins head, validation digest, harness, policy, and expected main. Evidence digests are re-verified before approval. |
| Anonymous replay viewer starts paid work | The gateway exposes only replay reads and allocated previews. A preview cannot start without an operator allocation and cannot extend its absolute expiry. |
| Secret leakage in logs or replay | The broker redacts tokens. Replay publication is a whitelist transformation that also scrubs token-shaped strings. No secret is in `VITE_*`, frontend bundles, or fixtures. |
| Cross-site request forgery | Origin allowlist, JSON-only bodies, custom header requirement. |

## Known limits

- Black-box checks cover specified behavior only. They are evidence, not proof against a deliberately adversarial implementation.
- In the `durable_object` scheduling policy, every container process has root capabilities. The design never relies on Linux users or file permissions for isolation.
- The demo customer header (`X-Demo-Customer`) selects a synthetic identity. It is not an authentication pattern.
- One active mutating session per project. The coordinator is a single Durable Object; this is not a SaaS tenancy design.
- The model ceiling is an application-level estimate. Network retries can cause extra billed requests; ambiguous outcomes are booked as uncertain charges, not as free.
- The broker container has outbound Internet so it can reach Artifacts. A compromise of the broker image would expose the short-lived tokens of in-flight operations.
