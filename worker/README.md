# worker/ — the real receiver

`graph/` was always a prototype for this: a Cloudflare Worker + Durable
Object that imports `graph/`'s pure logic directly and adds the I/O a real
system needs — GitHub API calls, a D1 log, the watchdog alarm. Not
deployed anywhere. This repo has no live Cloudflare account access; see
`wrangler.toml`'s header comment for exactly what running this for real
still needs (`wrangler login`, `wrangler d1 create`, three required secrets
plus one optional one — see `wrangler.toml`'s header for the exact list).

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

**91 unit tests** (`npm test` — the `"unit"` vitest workspace project;
see `vitest.workspace.ts`) cover `coordinate.ts` (the decision logic,
against fake in-memory deps), `webhook-parse.ts` (payload mapping +
signature verification), `github-client.ts` and `routines-client.ts`
(against mocked `fetch`, including the `GITHUB_API_BASE_URL`/
`CLAUDE_API_BASE_URL` override seam used below) — **plus `index.ts` and
`issue-coordinator.ts` themselves** (`test/index.test.ts`,
`test/issue-coordinator.test.ts`), covering: webhook signature
verification end-to-end (missing/wrong/correct signature, and the
no-secret-configured skip path), routing to the correct DO keyed by
`owner/repo#issueNumber` (including that two different issues or two
different repos never produce the same key), delivery-id dedup, the
watchdog alarm actually *firing* (not just being scheduled — the pending-
fire case posts the real comment and clears state; the no-pending case is
a harmless no-op), and that two `IssueCoordinator` instances (standing in
for two different issues' real DOs) never share dedup/pending-fire state.
All of this via the same fake-deps pattern `coordinate.test.ts` already
used — no `@cloudflare/vitest-pool-workers` (that package needs vitest
^4, and this repo pins vitest ^2; pulling it in would mean an unprompted
major-version bump of an existing dependency, not just adding a new one —
skipped for that reason). True DO storage isolation once two ids differ
is a Cloudflare platform guarantee that a fake-object test can't further
prove; what these tests actually catch is a bug in the *key construction*
itself. Clean `tsc --noEmit`.

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

## Testing outcome fidelity with a real agent

Everything above proves the *infrastructure* (Worker, DO, self-trigger
guard) is correct. It says nothing about whether a real agent, handed a
loop's actual instructions, would produce the right outcome — the earlier
whole-stack run's `build_succeeded` comment was hand-typed via curl,
standing in for what the loop would do, not something a loop actually did.

`agent-runner.mjs` closes that gap using the real
**`@anthropic-ai/claude-agent-sdk`** (not a mock, not a stub — it makes a
real, billed Anthropic API call), for every loop whose real signal *is* a
self-reported comment: `issue-build-loop`'s Step 3
(`build_succeeded`/`build_blocked`) and `auto-release-loop`'s Step 2.5
(`release_blocked`) and Step 4 (`release_published`) — the full
`agent-outcomes` catalog. It is deliberately scoped per outcome: it does
not simulate the loop's real work (the worktree, implementation, CI,
`mcp-review`; the fetch-and-pin sequence, the `release-reviewer` agent, the
actual merge/tag/publish/dev-sync) — that's real infrastructure work, not
something worth faking here. It starts from "the work up to the outcome
step already happened" as a given, and checks only whether the agent then
does what that step says to do about it — the part that actually mattered
and was untested. The system prompt is the *verbatim* text of that step
plus the `agent-outcomes` SKILL.md, read live off disk, so this test
drifts with the real skills, never with a paraphrase of them. The agent
gets six tools (`get_labels`/`add_label`/`remove_label`/`post_comment`/
`create_issue`/`close_issue`, each taking an explicit `issue_number`) wired
to this same mock's real in-memory state — a call it makes fires the same
webhook a raw curl would.

```bash
curl -X POST http://127.0.0.1:8943/repos/o/r/issues/500/labels \
  -H "Content-Type: application/json" -d '{"labels":["ai-ready"]}'

curl -X POST http://127.0.0.1:8943/mock/run-agent-outcome-test \
  -H "Content-Type: application/json" \
  -d '{"routine":"issue-build-loop","owner":"o","repo":"r","issueNumber":500,"scenario":{"type":"build_succeeded","pr":77}}'
```

`routine` + `scenario.type` select which entry of `agent-runner.mjs`'s
`OUTCOME_CONFIGS` runs — `issue-build-loop`'s `build_succeeded`
(`pr` number) / `build_blocked` (`reason` string), or `auto-release-loop`'s
`release_blocked` (`pr`, `version`, `findings`) / `release_published`
(`pr`, `version`). The response is the ordered list of tool calls the
agent actually made, its final labels/comments/state, and a `checks`
object asserting the documented contract: labels swapped correctly (or,
for `auto-release-loop`, the new blocked-issue created / the triggering
issue closed), a comment posted, the right `<!-- agent-outcome:<routine>
-->` marker present, and its JSON matching the catalog shape in
`agent-outcomes/SKILL.md`. Run against all four scenarios during this
pass: every check passed, with no scripted tool sequence — the agent
decided the calls itself from the skill text alone, including correctly
creating a new blocked-issue and labelling it for `release_blocked`.

**One real gotcha this surfaced, now fixed in `agent-runner.mjs`:**
`query()`'s `cwd` defaults to `process.cwd()`, which — run from inside this
repo — loads this repo's own `.claude/settings.json`: SessionStart hooks,
every marketplace plugin's skills/slash-commands, all of it. An early
version without isolation actually ran those hooks and produced
duplicated/misnamed tool-call entries in the result. `settingSources: []`
in the query options ("SDK isolation mode" per the SDK's own doc comment)
fixes this — confirmed by re-running with and without it. Anyone reusing
this pattern elsewhere should set it explicitly; don't assume a scripted
`query()` call is sandboxed from the invoking repo by default.

This makes a real API call — don't run it on every PR or without thinking
about cost. It **is** scripted into CI, deliberately scoped: see the next
section for how and when.

## The same four scenarios, as real vitest tests, release-gated

The curl-driven walkthrough above is for verifying skill-text fidelity by
hand. The same underlying call (`runLoopOutcome`) is also a real,
standardised vitest suite — `test/evals/outcome-reporting.eval.test.mjs`,
one `it()` per scenario, `describe`/`it`/`expect` like every other test in
this repo, not a hand-rolled script. It lives in its own **vitest
workspace project** (`vitest.workspace.ts`, project `"evals"`), separate
from the normal `"unit"` project everything else runs in:

```bash
npm test        # "unit" project only — fast, free, deterministic, CI-blocking on every PR
npm run test:evals  # "evals" project — real Agent SDK calls, ~$2.50-3/run, ~70s
```

`npm test` never touches the evals project — it's a distinct workspace
project, not a file-name convention `npm test` happens to skip. CI wires
the two at different cadences: `worker-tests.yml` runs `npm test` on
every PR/push touching `worker/**` or `graph/**`; `worker-agent-evals.yml`
runs `npm run test:evals` only when a GitHub Release publishes (see
`CLAUDE.md`'s Releases section) — same one-framework, two-speeds split the
MCP product repos use for their own eval suites, not a bespoke system.
Needs `ANTHROPIC_API_KEY` provisioned as a secret before it can run for
real in CI — not done as of this writing.

**Second gotcha, real but mundane:** `.dev.vars.example`'s
`ROUTINE_IDS_JSON` originally only had an entry for `issue-build-loop`.
Kicking off `auto-release-loop` (or any of the other three) without
adding its own entry makes `fireRoutine()` throw *before*
`logTransition` runs — a genuine 500 to the webhook sender, and a silently
missing D1 row, not a Worker bug. Fixed by giving `.dev.vars`/
`.dev.vars.example` a fake ID for all five loops.

## The black-box shape: everything real except the loops themselves

The goal this converged on: **everything in the stack is real — Worker,
DO, D1, the reducer, the mock's webhook emission — except the five loops
themselves, which are black-boxed.** Each loop's black-box stand-in uses
whichever mechanism actually matches how that loop's signal reaches
GitHub in reality, not one uniform mechanism for all five:

| Loop | Real observable signal | Black-box mechanism |
|---|---|---|
| `issue-build-loop` | self-reported outcome comment | real agent vs. verbatim Step 3 (`run-agent-outcome-test`) |
| `auto-release-loop` | self-reported outcome comment | real agent vs. verbatim Step 2.5/Step 4 (`run-agent-outcome-test`) |
| `rework-loop` | a git push (native webhook) | direct synthetic webhook, no agent (`/mock/simulate-pr-push`) |
| `merge-flow` | a PR merge (native webhook) | direct synthetic webhook, no agent (`/mock/simulate-pr-merge`) |
| `merge-flow` (gate-failed) | `check_suite.completed`, independently re-verified | direct synthetic webhook + `/mock/set-pr-facts`, no agent (`/mock/simulate-check-suite`) |
| `issue-discuss-loop` | none — no outbound `graph/` transition | out of scope; nothing to black-box |

Using an LLM call for the native-signal loops would be strictly worse, not
just wasted cost — a real git push or a real merge isn't something an
agent "decides" to report in words; it's a raw GitHub event, so firing
that event directly is the *more* faithful stand-in, not a shortcut.

**`merge-flow`'s gate-failed cases are the one loop signal that's neither
a native single-fact webhook nor a self-report — it's the Worker
independently re-deriving a judgment from several live facts**, matching
option (b) from the discussion that led here: rather than trust a
self-reported artifact, `worker/src/coordinate.ts`'s
`handleCheckSuiteCompleted` re-fetches the full check-run list for the
head SHA, the latest review state, and mergeability — real GitHub-shaped
calls (`getPull`/`getCheckRuns`/`getLatestReviewState` in
`github-client.ts`) — and `graph/github/merge-gate.ts`'s pure
`deriveMergeGateOutcome()` decides soft/hard/still-pending/pass from those
facts alone, never from anything `merge-flow` itself reported. That's what
lets `MERGE_GATE_FAILED_SOFT`/`HARD` keep their `verifiedBy: "deterministic"`
tag in `graph/graph.ts` for real, instead of it being aspirational.
`/mock/set-pr-facts` + `/mock/simulate-check-suite` let this be exercised
against the real Worker+D1 the same way as everything else — run live
during this pass for all four cases (still-pending, all-green/no-op,
soft-fail, hard-fail); see the D1 rows this produced in the section below.

## All three pieces together: real agent + mock GitHub + real local Worker

Run for real, together (`wrangler dev --local` + `mock-github` wired to it
with `WORKER_WEBHOOK_URL`, then `/mock/simulate-label` or
`/mock/simulate-pr-label` to kick off, then `/mock/run-agent-outcome-test`
or the native-signal endpoints for the outcome), a loop's black-boxed
action — whether an agent's tool call or a synthetic webhook — fires the
same webhook path the HTTP routes use, and the D1 log shows what the real
reducer actually did with it. Six transitions, run this way, across four
loops:

```
issue-build-loop   id=9  from=none          event=labelled_ai_ready  -> label(ai-ready), run issue-build-loop
issue-build-loop   id=10 from=ai-generated   event=build_succeeded    -> APPLIED: noop (post-swap confirm)
auto-release-loop  id=13 from=auto-releasing event=release_published  -> APPLIED: close
rework-loop        id=15 from=none           event=labelled_auto_reworking -> label(auto-reworking), run rework-loop
rework-loop        id=16 from=auto-reworking event=rework_pushed      -> APPLIED: unlabel
merge-flow         id=17 from=none           event=labelled_auto_merging  -> label(auto-merging), run merge-flow
merge-flow         id=18 from=auto-merging   event=merged             -> APPLIED: close
merge-flow (gate)  id=19 from=none           event=labelled_auto_merging  -> label(auto-merging), run merge-flow
merge-flow (gate)  id=20 from=auto-merging   event=merge_gate_failed_soft -> APPLIED: noop (a real failed check-run, independently re-fetched)
merge-flow (gate)  id=22 from=auto-merging   event=merge_gate_failed_hard -> APPLIED: unlabel (real mergeable:false, independently re-fetched)
```

Every kickoff labeling and every native signal (`rework_pushed`, `merged`,
`merge_gate_failed_soft`/`hard`) was correctly **applied** for real — the
reducer matched a rule and, for every one of these, made a real,
additional GitHub write of its own (`unlabel`, `close`, or nothing for a
`noop` confirm) on top of what the loop already did, exactly as `graph.ts`
intends. The two `merge_gate_failed_*` rows are the most significant of
these: unlike the native single-fact signals, the Worker itself made three
independent GitHub-shaped reads (`getPull`/`getCheckRuns`/
`getLatestReviewState`) and *derived* the failure — nothing self-reported
it. A same-shaped run with an in-progress check suite and with an
all-green one both correctly produced **zero** additional rows (still
pending / gate genuinely passes — not this reducer's job to say so). In
every run, the label webhooks the agent's own `remove_label`/`add_label`
calls fired were correctly dropped by the self-trigger guard — confirmed
with a real agent doing the firing, not just curl.

**`id=10`'s row above reflects a fix, not the original finding.** The
first time this ran, `build_succeeded` arrived from state `ai-generated`
but the rule was keyed on `ai-ready` — issue-build-loop's own Step 3
always swaps the label *before* posting the comment, so a rule keyed on
the pre-swap state can never fire, and this dropped as "no matching
rule" every time, for all three of `build_succeeded`, `build_blocked`,
and `release_blocked` (the fourth, `release_published`, never had this
problem — `auto-release-loop`'s Step 4 doesn't remove its label before
closing, so it was already keyed correctly by accident). Fixed by
rekeying all three to their post-swap state
(`AI_GENERATED`/`AI_BLOCKED`/`"none"`), each now firing an idempotent
`noop` confirm — same shape `MERGED`'s `to: close` already used. See
`graph/graph.ts`'s comments on each rule.

## The label rename is now a coordination hazard, not just future work

Fixing the mismatch this test first surfaced (`issue-build-loop`'s live
`SKILL.md` said `ready-for-ai`/`generated-by-ai`; `graph/` already used the
renamed `ai-ready`/`ai-generated`) meant executing the text side of
[10-label-rename.md](../docs/agent-orchestration/10-label-rename.md)'s
migration across all 18 files — done, this pass. **That file itself warns
this needs to land as one coordinated cutover, not incrementally**, and
that warning is no longer hypothetical: the skill files now instruct every
loop to add/remove labels spelled the new way, but **no live GitHub repo's
actual label is renamed, and no routine's trigger filter config is
updated** (both outside this repo's reach). Deployed as-is today, against
real GitHub labels still spelled the old way, a real loop run would try to
remove a label that isn't actually on the issue (a 404, silently or not
depending on the client) and never actually clear the real trigger label —
worse than before this pass, not better, until the live rename + trigger
config land in the same coordinated change. See
[10-label-rename.md](../docs/agent-orchestration/10-label-rename.md) for
what "coordinated" requires.

## The direct routine→DO heartbeat channel

`graph/routines/from-routine.ts`'s `parseRoutineSignal()` — a "process"
heartbeat or "completion" fast-path echo a routine can send straight to
its DO, bypassing GitHub entirely — now has a real receiving endpoint:
**`POST /routine-signal`** on this Worker. Deliberately narrow, matching
what that file's own design already specified: neither kind ever calls
`reduce()` or writes a label/close. `"process"` re-schedules the watchdog
alarm (`coordinate.ts`'s `coordinateRoutineSignal` → `setPendingFire`
again with the same info); `"completion"` cancels it early
(`clearPendingFire`) — the real state transition still only ever comes
from `github/from-github.ts` reading the actual GitHub comment, later.
Losing a call here costs a slightly-late watchdog comment or a
duplicate-but-harmless cancel a moment later, never a wrong state.

Auth: `ROUTINE_SIGNAL_SECRET`, checked as `Authorization: Bearer <secret>`
— unset skips the check entirely, same permissive-for-local-dev shape as
`GITHUB_WEBHOOK_SECRET`. Routing: `{owner, repo, signal}` in the body,
keyed to the same DO as the webhook path (`owner/repo#signal.issue`). A
signal for a routine that isn't the one currently pending on that issue
(`pending.run !== signal.routine`) is rejected as `mismatched_routine`
rather than silently accepted — a light guard against a stale/misrouted
signal touching the wrong run's watchdog.

Unit tested end to end — `coordinate.test.ts` (the parse/mismatch/extend/
cancel logic against fake deps), `issue-coordinator.test.ts` (the DO's
`/routine-signal` branch, real `ctx.storage.setAlarm`/`deleteAlarm` calls),
`index.test.ts` (auth, routing, validation). **Not verified**: nothing has
actually pointed `AGENT_OUTCOMES_ENDPOINT` (the `agent-outcomes` plugin's
`PostToolUse` hook — see `docs/agent-orchestration/11-outcome-artifact.md`)
at this endpoint, so the *real* sending side has never been exercised
against it, only this receiving side in isolation.

## What's NOT verified

- **Nothing here has talked to the real GitHub API or the real Claude
  routines API.** `github-client.ts`/`routines-client.ts` are written
  against their documented shapes; `mock-github/server.mjs` is a
  hand-written stand-in for those shapes, not the real thing, and it's
  never been diffed against real GitHub/Claude API responses for drift.
- **The mock doesn't sign its webhooks** — the whole-stack test above
  never sets `GITHUB_WEBHOOK_SECRET`, so `index.ts`'s signature-check
  branch never ran *during that specific test*. It's no longer untested
  overall, though: `test/index.test.ts` exercises the full branch
  (missing signature, wrong signature, correct signature, no secret
  configured) against a real computed HMAC, not just `verifySignature()`
  in isolation.
- **`/routines/:id` (the kickoff fire) is still a no-op log-and-200 stub**
  — deliberately: at kickoff there's nothing for a real agent to decide
  yet (the loop hasn't done any work), so there's nothing meaningful to
  test there. The real-agent tests exercise each loop's outcome-reporting
  step directly via `/mock/run-agent-outcome-test`, not through this
  endpoint.
- **Outcome-reporting fidelity is checked for `issue-build-loop` and
  `auto-release-loop`; everything before that step in either loop (the
  worktree, driving CI, `mcp-review`, the fetch-and-pin sequence + the
  `release-reviewer` agent, the actual merge/tag/publish/dev-sync) is
  not** — each real-agent test starts from "the work up to here already
  happened" as a given, not from a real build or a real release.
  `rework-loop` is covered narrowly — only its one native signal (a push)
  through the reducer, not the fix-and-push work itself. `merge-flow` is
  covered more fully than the others: both its native merge signal *and*
  its gate-failed cases now go through a real, independently-verified
  aggregation (see the black-box shape section above) — but the actual
  merge call, and the human-approval/base-branch checks that don't hinge
  on `check_suite.completed`, are still `merge-flow`'s own, untested-here
  territory. `issue-discuss-loop` has no test at all — no outbound
  `graph/` transition exists for it to exercise.
- **The watchdog alarm's *firing* is verified via a direct unit call
  (`test/issue-coordinator.test.ts`), not a real elapsed 30 minutes.**
  `alarm()` is called directly against a fake `ctx.storage` pre-populated
  with a pending fire, and asserted to post the real comment and clear
  state (plus a no-op case with nothing pending) — genuine coverage of
  the firing logic itself, but still not the same as observing
  Miniflare's own alarm-scheduling clock actually elapse and invoke it;
  that would need Miniflare's time-travel testing APIs, not done here.
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
- `getLatestReviewState` is a deliberate simplification, not full parity
  with github-ops's real review-state operation — it takes the single most
  recent review's state across all reviewers, not each reviewer's own
  latest state collapsed individually. Flagged in `merge-gate.ts`'s doc
  comment, not silently assumed identical.
- The "right base" gate (Step 2's fourth check — a PR into `main` on a
  gitflow repo is `auto-release-loop`'s territory, not `merge-flow`'s) is
  deliberately excluded from `deriveMergeGateOutcome` — a static PR
  property `check_suite.completed` completing doesn't change or motivate
  re-checking, so it's out of scope for this specific event-triggered path.
