# Demo script (about 8 minutes)

Record from the deployed operator UI. Show a live session for real concurrency, and the fixture session for the guaranteed counterexample. Label every replay or sped-up section on screen. Do not stage live progress.

Before you record:

1. `pnpm smoke --env dev` passes.
2. You have one settled **live** session (for the timeline and the predicted interactions) and one **fixture** session in `ready` (for review and promotion). If main already moved, use a fresh project slug (see `deployment.md`).
3. Open the public replay of the fixture run in a second tab.

| Time | Show | Say (plain, short) |
|---|---|---|
| 0:00–0:45 | Title, then the storefront goal on the session header | Two changes can each be correct, merge with no conflict, and still break each other. Converge finds that before a human has to. |
| 0:45–2:00 | Live session: three agent cards, the concurrency timeline, the three proposal forks (repo names) | Three model-driven agents work at the same time, each in its own workspace and its own Artifacts fork, from one pinned baseline. The lanes show real overlapping model and tool activity. |
| 2:00–3:00 | Agent drawers: Pricing intent (`unit-price.dimensions` → `[productId, membershipTier]`), Caching intent (`eq [productId]`); the interaction panel shows "predicted" | Each agent declares what it changes and what it assumes. A generic rule compares them. Pricing changes the price dimensions; Caching assumes only product matters. That is a predicted interaction, before any test runs. |
| 3:00–4:15 | Fixture session, matrix row "Member pricing + Unit-price cache": failed `pricing.isolation`; open the counterexample | Each change passes alone. Together they merge cleanly and fail. After a member asks for a quote, a regular customer gets 8000 instead of 10000. The harness runs outside the candidate's container, so the candidate cannot fake this result. |
| 4:15–5:30 | Repair proposal: base = the failed commit, dependencies = the exact Pricing and Caching revisions; the anchor graph; the repair diff (cache key adds membership tier) | The repair starts from the exact failed commit. The final candidate reuses that commit as its anchor and merges only Checkout and the repair, so the history is the history that was tested. |
| 5:30–6:30 | Final review: all checks pass, cache still active (`cache.reuse`), validation digest, expected main, exact head; the button "Approve commit 39b8784 for promotion to main" | The human approves one exact commit and its evidence, not a branch name. |
| 6:30–7:15 | Promote; promotion result; main SHA equals the approved SHA | Promotion pushes that exact commit with a lease on the expected main. If main moved, it stops and asks for review. |
| 7:15–8:00 | Architecture slide (Workers, Durable Object coordinator, Workflows, Artifacts, broker and execution containers, R2), limits, the public replay | Limits: checks are evidence of specified behavior, not a proof. The storefront is synthetic. The code is MIT; the README lets you run it in your own account. |

If the live run avoids the bug (an agent reacts to the predicted interaction), say so and show the prevention. Then use the fixture session for the counterexample. Do not present fixture output as live.
