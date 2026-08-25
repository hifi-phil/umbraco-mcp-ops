# worker/ — the real receiver

`graph/` was always a prototype for this: a Cloudflare Worker + Durable
Object that imports `graph/`'s pure logic directly and adds the I/O a real
system needs — GitHub API calls, a D1 log, the watchdog alarm. Not
deployed anywhere. This repo has no live Cloudflare account access; see
`wrangler.toml`'s header comment for exactly what running this for real
still needs (`wrangler login`, `wrangler d1 create`, three secrets).

## Structure — same "thin shell around tested pure logic" shape as `graph/`

```
src/
  coordinate.ts        the actual dispatch logic — dependency-injected,
                        no ctx.storage/fetch/D1 — tested with plain vitest
  webhook-parse.ts      raw GitHub webhook -> routing info + WebhookPayload
                        — pure, tested with plain vitest
  github-client.ts      real fetch-based GitHub REST calls
  routines-client.ts    real fetch-based Claude Code routines API call
  issue-coordinator.ts  the Durable Object class — thin, wires
                        coordinate.ts's Deps to real storage/D1/clients
  index.ts              the Worker fetch handler — thin, wires
                        webhook-parse.ts to the right DO instance
```

## What's actually verified, and how

**40 unit tests** (`npm test`) cover `coordinate.ts` (the decision logic,
against fake in-memory deps), `webhook-parse.ts` (payload mapping +
signature verification), `github-client.ts` and `routines-client.ts`
(against mocked `fetch`, including the `GITHUB_API_BASE_URL`/
`CLAUDE_API_BASE_URL` override seam used below). Clean `tsc --noEmit`.

**A real local smoke test**, via `wrangler dev --local` (Miniflare — no
Cloudflare account needed) plus a throwaway local HTTP stub standing in
for both the GitHub and Claude APIs (pointed at via the base-URL env
overrides, so nothing in this smoke test ever made a real external call):

1. `npx wrangler d1 migrations apply agent-orchestration-log --local`
2. `npx wrangler dev --local` (with `.dev.vars` pointing both API base
   URLs at the local stub)
3. `curl -X POST http://localhost:.../ -H "X-GitHub-Event: issues" -H "X-GitHub-Delivery: ..." -d '{"action":"labeled","label":{"name":"ai-ready"},"repository":{...},"issue":{"number":412}}'`

Result: the Worker routed to the correct DO instance, called `translate()`
→ `reduce()` (real `graph/` code, not mocked), got the `labelled_ai_ready`
rule, called the GitHub label-add endpoint, fired the routine (POST to
`/routines/rt_fake` with the expected `additional_context`), and wrote a
real row to the local D1 `transitions` table. A second delivery with the
same `X-GitHub-Delivery` correctly deduped instead of re-processing.

The label-add call actually fired an "add" op rather than a no-op — that's
the stub server's own limitation (it's stateless, always returns `[]` for
`GET .../labels`), not a bug: `coordinate.test.ts`'s fake deps *do* model
a label already being present and correctly produce zero ops for that
case, matching `graph/github/to-github.ts`'s own tests.

## What's NOT verified

- **Nothing here has talked to the real GitHub API or the real Claude
  routines API.** `github-client.ts`/`routines-client.ts` are written
  against their documented shapes, not exercised against them.
- **The watchdog alarm's *firing* (`alarm()`) is untested beyond code
  review** — the smoke test exercised the code path that *sets* it
  (`setPendingFire` → `ctx.storage.setAlarm`), which `coordinate.test.ts`
  covers deterministically, but observing a real 30-minute alarm fire
  needs either waiting it out or Miniflare's time-travel testing APIs,
  neither done here.
- **`issue-coordinator.ts` and `index.ts` themselves have no automated
  tests** — only the smoke test above, once, by hand. Getting
  `@cloudflare/vitest-pool-workers` running would close this; not done in
  this pass (see the file-level comments in both for the reasoning).
- **Real deployment** — `wrangler login`, a real D1 database, real
  secrets, a real GitHub webhook subscription pointed at this Worker.
  None of that has happened, and doing it is a deliberate, separate step
  (see `docs/agent-orchestration/07-build-phases.md`'s Phase 5 graduation
  table — nothing gets cut over until this is live *and* shadow-mode
  verified against real traffic, not just a local stub).

## Known gaps in the coordinator itself

- `delivery_id` isn't threaded into the D1 log row (`insertTransition`
  hardcodes `null`) — the dedupe check uses DO storage, not the log, so
  this doesn't affect correctness, just makes the log slightly less
  useful for debugging a specific delivery.
- `check_suite.completed`/`merge_gate_failed_*` have no real path through
  `coordinateWebhook` yet, consistent with `graph/`'s own documented gap —
  see `docs/agent-orchestration/11-outcome-artifact.md`.
