# Submission checklist

Source: official rules (PDF, 4 pages) and the competition page, read 2026-10-03. Deadline: **2026-10-14, 11:59 PM PDT**. Finalists are announced 2026-10-16 and present on 2026-10-21 at Cloudflare Connect, San Francisco.

The rules forbid automated entry. **You must submit the form yourself** and select "Yes" on the Terms and Conditions yourself. This repository prepares the materials only.

## Eligibility (you confirm)

- [ ] You are a legal resident of the United States or Canada.
- [ ] You are 18 or older.
- [ ] You are not a Cloudflare employee, officer, or director (or immediate family or household member), and not a government employee.
- [ ] One submission per entrant.

## Required materials

| Requirement | Status | Where |
|---|---|---|
| Uses Cloudflare Workers and Artifacts | Done | Control and gateway Workers; canonical repo, proposal forks, integration repo in Artifacts |
| Multiple agents work on changes at the same time | Done (fixture); live run in progress | `docs/build-status.md`, concurrency timeline in the UI |
| Source license file (MIT / Apache 2.0 / BSD) | Done | `LICENSE` (MIT) |
| Instructions to run the project | Done | `README.md`, `docs/deployment.md` |
| Public source repository | Not published | Needs your approval of destination and visibility |
| 5–10 minute demo video | Not recorded | Script in `docs/demo-script.md` |
| Original content; no third-party copyrighted assets | Done | Synthetic storefront; no real customer data, no employer code |

## Judging weights (rules §6)

| Criterion | Weight | What the demo should show |
|---|---|---|
| Originality and quality of the agent-collaboration prototype | 50% | Declared intents; predicted interaction; protected counterexample; additive anchored repair; exact-commit approval and lease-guarded promotion |
| Multi-agent concurrency, coordination, context, review, conflict handling | 25% | Overlapping live agent activity; targeted inbox messages; matrix of candidates vs checks; text conflicts kept separate from semantic failures |
| Ease of use and product experience | 25% | One-screen causal story; final review that names the commit it authorizes; clear live / fixture / replay labels |

## Before you submit

- [ ] Choose the public repository host, owner, and name. Confirm visibility.
- [ ] Rotate the Cloudflare API token and the Anthropic key after the build (you said you would).
- [ ] Check `git log` and the repository for secrets: `.env.local` and `.dev.vars` are gitignored; `git grep -nE 'cfat_|sk-ant-|art_v1_'` should return nothing.
- [ ] Record the video from `docs/demo-script.md`. Label replay or compressed waits on screen.
- [ ] Put the operator note in the form: the operator UI is behind Cloudflare Access; judges can use the public replay URL and the README to run their own copy.
- [ ] Fill in the form at https://www.cloudflare.com/git-competition/ yourself.
