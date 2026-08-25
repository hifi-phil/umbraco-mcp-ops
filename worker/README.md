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

## Testing the whole stack locally

`mock-github/server.mjs` is a small, stateful stand-in for both the
GitHub REST API and the Claude routines API — not a canned-response stub.
It tracks real per-issue label/comment/open-closed state in memory, and
critically, **it fires a real webhook back to the Worker on every state
change it makes**, exactly like real GitHub does — including for changes
the Worker's *own* calls cause. That's what makes it possible to test the
self-trigger guard for real, not just against a fixed sender in a unit
test.

```bash
cd worker
npm install
npx wrangler d1 migrations apply agent-orchestration-log --local
cp .dev.vars.example .dev.vars                      # points both APIs at the mock

# terminal 1
WORKER_WEBHOOK_URL=http://127.0.0.1:8787/ BOT_TOKEN=mock-bot-token npm run mock-github

# terminal 2
npx wrangler dev --local
```

Then drive it as if a human labelled an issue on github.com:

```bash
curl -X POST http://127.0.0.1:8943/mock/simulate-label \
  -H "Content-Type: application/json" \
  -d '{"owner":"hifi-phil","repo":"umbraco-mcp-ops","issueNumber":500,"label":"ai-ready","senderLogin":"phil"}'
```

**What actually happened, verified, in one run of this:**

1. The label-add fired a real webhook; the Worker read `translate()` →
   `reduce()` → found no label ops needed (the label was already there,
   correctly excluded via `LABEL_JUST_ADDED_BY`) → fired the routine (the
   mock's routines stub logged the exact `additional_context`) → wrote
   one real D1 row.
2. Posting `issue-build-loop`'s `build_succeeded` outcome comment — **as
   the bot** (`Authorization: Bearer mock-bot-token`, matching how the
   real loop would authenticate) — via
   `POST /repos/.../issues/500/comments` triggered the real
   remove-`ai-ready`/add-`ai-generated` label ops, each of which the mock
   echoed back as its own webhook (`issues.unlabeled`, `issues.labeled`),
   attributed to the bot identity.
3. **Both of those self-fired webhooks were correctly dropped** —
   `issues.unlabeled` has no case in `translate()` at all;
   `issues.labeled` hit the identity-based self-trigger guard
   (`isOwnBot`) before even reaching the label-name switch. Confirmed by
   the D1 log ending up with exactly **2** rows (the two real
   transitions), not 4 — the self-fired webhooks never reached
   `logTransition`, let alone caused a third transition.
4. Final mock state: `labels: ["ai-generated"]`, `ai-ready` genuinely
   gone, the outcome comment recorded — `GET /mock/state` to inspect.

`POST /mock/reset` clears all mock state between runs (D1 needs its own
`DELETE FROM transitions;` via `wrangler d1 execute --local` if you want a
clean log too).

## What's NOT verified

- **Nothing here has talked to the real GitHub API or the real Claude
  routines API.** `github-client.ts`/`routines-client.ts` are written
  against their documented shapes; `mock-github/server.mjs` is a
  hand-written stand-in for those shapes, not the real thing, and it's
  never been diffed against real GitHub/Claude API responses for drift.
- **The mock doesn't sign its webhooks.** `GITHUB_WEBHOOK_SECRET` and
  `webhook-parse.ts`'s `verifySignature()` are exercised by unit tests
  with a hand-computed HMAC, but the whole-stack test above never sets
  `GITHUB_WEBHOOK_SECRET`, so the signature-check branch in `index.ts`
  never actually ran during it.
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
