# worker/ — the real receiver

`graph/` was always a prototype for this: a Cloudflare Worker + Durable
Object that imports `graph/`'s pure logic directly and adds the I/O a real
system needs — GitHub API calls, a D1 log, the watchdog alarm. Deployed
with OpenTofu from `terraform/`; see "Deploying" below.

## Deploying

`terraform/` owns every real resource: the D1 database (with
`migrations/` applied), the Worker and its Durable Object, its secrets, and
its workers.dev route. `tofu destroy` removes all of it. GitHub reaches the
Worker through its **GitHub App**, which tofu can't manage (see below).

```bash
cd worker
npm ci && npm run build                     # wrangler bundles to dist/index.js
cd terraform
cp terraform.tfvars.example terraform.tfvars   # fill in; gitignored
export CLOUDFLARE_API_TOKEN=…   # account token: Workers Scripts: Edit, D1: Edit
export GITHUB_TOKEN=…           # Webhooks: write on the e2e sandbox only (the stub's own hook)
mkdir -p -m 700 ~/.local/state/umbraco-mcp-ops
tofu init -backend-config="path=$HOME/.local/state/umbraco-mcp-ops/agent-orchestration-worker.tfstate"
tofu apply
# later:
tofu destroy
```

- Re-run `npm run build` before `tofu apply` after any code change; the
  bundle's hash is what tells tofu the Worker changed.
- `mode` defaults to `shadow`. The webhook and routine-signal secrets are
  generated (`random_password`); read the routine one with
  `tofu output -raw routine_signal_secret`.
- **State lives outside the repo**, at
  `~/.local/state/umbraco-mcp-ops/agent-orchestration-worker.tfstate`, so
  deleting a worktree or checkout doesn't lose it. From any fresh checkout,
  run the same `tofu init -backend-config=…` line and you're pointing at the
  same state again. It holds every secret in plain text: keep it off shared
  drives and never commit it.
- The migrations step shells out to wrangler
  (`terraform/apply-d1-migrations.sh`) because tofu can't run SQL.

**The GitHub App** (set up by hand, once) is the Worker's identity and its
webhook source:
- **Permissions:**
  - Issues, Pull requests: read & write
  - Checks, Contents: read
- **Webhook:**
  - Active
  - URL: `tofu output -raw worker_url`
  - Secret: `tofu output -raw webhook_secret`
  - Events: Issues, Issue comment, Pull request, Check suite
- **Tofu variables:** its ID and private key go in `github_app_id` and
  `github_app_private_key`.
- **Connecting a repo** is installing the App on it, plus the repo's entry
  in `repo_routines` (its loop-dispatch routine). There's no per-repo hook to
  add, so the old caller workflow and its secrets aren't needed.

- **After the first apply, set `deployed_do_migration_tag`** in
  `terraform.tfvars` to the tag `tofu output migration_tag` shows (`"v2"`
  for a fresh deploy). Every Worker upload re-sends the Durable Object
  migration, and Cloudflare rejects one whose `old_tag` doesn't match the
  deployed tag (412, "Actor migration tag precondition failed"; hit on the
  first code update, 29-09-2026). Leave it unset on a fresh deploy, since
  that's what creates the class, and unset it again after a `destroy`.
  `tofu output migration_tag` shows the deployed tag.

**Not yet verified against a real account:** whether `destroy` deletes a
Worker that still has a Durable Object namespace cleanly, or needs the
namespace removed first.

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

**135 unit tests** (`npm test` — the `"unit"` vitest workspace project;
see `vitest.workspace.ts`) cover `coordinate.ts` (the decision logic,
against fake in-memory deps), `webhook-parse.ts` (payload mapping +
signature verification), `github-client.ts` and `routines-client.ts`
(against mocked `fetch`, including the `GITHUB_API_BASE_URL` override seam
used below; `routines-client.ts` fires each repo's loop-dispatch routine
from `REPO_ROUTINES_JSON`, so pointing it at the mock is just a Fire URL) — **plus `index.ts` and
`issue-coordinator.ts` themselves** (`test/index.test.ts`,
`test/issue-coordinator.test.ts`), covering: webhook signature
verification end-to-end (missing/wrong/correct signature, and the
no-secret-configured skip path), routing to the correct DO keyed by
`owner/repo#issueNumber` (including that two different issues or two
different repos never produce the same key), delivery-id dedup, the
watchdog alarm actually *firing* (not just being scheduled — the pending-
fire case posts the real comment, swaps the in-flight label to `ai-stuck`,
logs a `watchdog_expired` row to D1 and clears state; a failing GitHub call
leaves the pending fire for the platform's alarm retry; the no-pending case
is a harmless no-op — see "The watchdog is a real event" below), and that two `IssueCoordinator` instances (standing in
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
  -d '{"owner":"hifi-phil","repo":"umbraco-mcp-ops","issueNumber":500,"label":"ready-for-ai","senderLogin":"phil"}'
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
   remove-`ready-for-ai`/add-`generated-by-ai` label ops, each of which the mock
   echoed back as its own webhook (`issues.unlabeled`, `issues.labeled`),
   attributed to the bot identity.
3. **Both of those self-fired webhooks were correctly dropped** —
   `issues.unlabeled` has no case in `translate()` at all;
   `issues.labeled` hit the identity-based self-trigger guard
   (`isOwnBot`) before even reaching the label-name switch. Confirmed by
   the D1 log ending up with exactly **2** rows (the two real
   transitions), not 4 — the self-fired webhooks never reached
   `logTransition`, let alone caused a third transition.
4. Final mock state: `labels: ["generated-by-ai"]`, `ready-for-ai` genuinely
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
  -H "Content-Type: application/json" -d '{"labels":["ready-for-ai"]}'

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

**Second gotcha, real but mundane:** a fire for a repo with no entry in
`REPO_ROUTINES_JSON` makes `fireRoutine()` throw *before* `logTransition`
runs — a genuine 500 to the webhook sender and a missing D1 row, by
design (an unfired routine in enforce mode is the stall this system
exists to prevent). `.dev.vars.example` has entries for the mock's `o/r`
and for `hifi-phil/umbraco-mcp-ops`.

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
issue-build-loop   id=9  from=none          event=labelled_ai_ready  -> label(ready-for-ai), run issue-build-loop
issue-build-loop   id=10 from=generated-by-ai   event=build_succeeded    -> APPLIED: noop (post-swap confirm)
auto-release-loop  id=13 from=auto-release event=release_published  -> APPLIED: close
rework-loop        id=15 from=none           event=labelled_auto_reworking -> label(auto-rework), run rework-loop
rework-loop        id=16 from=auto-rework event=rework_pushed      -> APPLIED: unlabel
merge-flow         id=17 from=none           event=labelled_auto_merging  -> label(auto-merge), run merge-flow
merge-flow         id=18 from=auto-merge   event=merged             -> APPLIED: close
merge-flow (gate)  id=19 from=none           event=labelled_auto_merging  -> label(auto-merge), run merge-flow
merge-flow (gate)  id=20 from=auto-merge   event=merge_gate_failed_soft -> APPLIED: noop (a real failed check-run, independently re-fetched)
merge-flow (gate)  id=22 from=auto-merge   event=merge_gate_failed_hard -> APPLIED: unlabel (real mergeable:false, independently re-fetched)
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
first time this ran, `build_succeeded` arrived from state `generated-by-ai`
but the rule was keyed on `ready-for-ai` — issue-build-loop's own Step 3
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

## Label spelling

This test first surfaced a mismatch between `graph/` (using the proposed
new label names) and the live skills (old names). The text was briefly
migrated to the new names, which left every real loop run unable to clear
its own trigger label. Since 28-09-2026 everything (`graph/`, skills,
`loop-dispatch`, this Worker, the tests) uses today's live spelling again.
The rename is deferred to one coordinated cutover; see
[10-label-rename.md](../docs/agent-orchestration/10-label-rename.md).

## The direct routine→DO heartbeat channel

`graph/routines/from-routine.ts`'s `parseRoutineSignal()` — a "process"
heartbeat or "completion" fast-path echo a routine can send straight to
its DO, bypassing GitHub entirely — now has a real receiving endpoint:
**`POST /routine-signal`** on this Worker. Deliberately narrow, matching
what that file's own design already specified: neither kind ever calls
`reduce()` or writes a label/close. `"process"` records the step on the
pending fire (`lastStep`/`lastStepAt`, quoted by the watchdog's comment if
the run then dies) and re-schedules the watchdog alarm (`coordinate.ts`'s
`coordinateRoutineSignal` → `setPendingFire`); `"completion"` cancels it early
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
`index.test.ts` (auth, routing, validation).

**The sending side** is the `agent-outcomes` plugin's `PostToolUse` hook
(`plugins/agent-outcomes/hooks/report-completion.sh`). From any session this
Worker fired, it sends a heartbeat naming the step, at most once a minute, and
a completion when the loop posts its outcome. It's verified live by the e2e
suite's `real hook` scenarios, which run the real hook against this deployed
Worker. To turn it on for real routines, set `AGENT_OUTCOMES_ENDPOINT` and
`AGENT_OUTCOMES_TOKEN` on the routine environment: see `new-loop-routine`'s
"Routine heartbeats" section.

## The reconciliation sweep (Phase 7)

`src/scheduler.ts`: one **Scheduler** Durable Object.

- **What it catches:** an issue left in a trigger state (`ready-for-ai`,
  `auto-release`, `auto-rework`, `auto-merge`) with no watchdog running and
  nothing logged for twice its routine's timeout. That's a fire that never
  got out, or a lost watchdog.
- **How it works:** its alarm sweeps every `sweep_minutes` (default 15),
  listing such issues per repo. Each issue's own DO decides
  (`coordinateReconcile`). A left-behind issue gets its routine fired again
  and watched, plus a `reconcile_refire` row. If that run dies too, the
  watchdog moves the issue to `ai-stuck`, which the sweep doesn't touch.
- **Why an alarm, not a Cron Trigger:** alarms are at-least-once and retried
  with backoff. Cron triggers have no retries and have been seen to stop
  silently.
- **It slows down when there's nothing live to watch:**
  - each alarm sets the next one before sweeping, so a failure keeps it
    going
  - a sweep with nothing live (no issue running, recently active, or newly
    re-fired or reported) slows the next to hourly (`SWEEP_IDLE_MINUTES`).
    It never stops: a lost webhook is exactly when nothing would restart it
  - every webhook brings it back to `sweep_minutes` (`/ensure`)

  A sweep with something new (a re-fire, a newly reported would-re-fire, an
  error) writes a `sweep` row (`owner` = `_scheduler`); any other writes
  nothing.
- **Modes:** `sweep_mode = "shadow"` (the default) only logs what it would
  re-fire, once per idle stretch. Run it that way first: a repo can have
  issues labelled from before the Worker. Even when enforcing:
  - a re-fire only happens when `MODE` **and that repo's watchdog** both
    enforce. Otherwise it's logged with `held`, because a shadow watchdog
    would leave the label on and the issue would be re-fired every sweep;
  - at most `sweep_max_refires` (3) re-fires happen per sweep.

  The e2e sandbox always enforces, and `POST /sweep` runs a sweep of the
  sandbox on demand.
- **Cost:** about 3,000 alarm runs a month at 15 minutes (fewer when it
  slows to hourly), plus one DO request per candidate per sweep and one
  `/ensure` per webhook. Ten open trigger-labelled issues is about 30,000
  a month. That's well inside the Free plan,
  and inside the $5 Paid allowance.

## The live-status dashboard (Phase 8)

`GET /status` shows every open issue the Worker is tracking: its state, the
routine last fired for it and which attempt that is, whether a watched run
is out now, the run's last heartbeat step, and its CI-fix reworks.

- **Open it:** `<worker_url>/status`, and sign in with GitHub. Only a
  GitHub account with a verified `@umbraco.com` or `@umbraco.dk` email gets
  in (`sign_in_domains`). The session lasts 7 days; "Sign out" is in the top
  bar.
- **Pages:**
  - `/status`: one list of every issue and PR the Worker has a log for,
    open or closed, across the attached repos (`repo_routines` plus the
    sandbox). Running first, then needing attention, then open, then the
    rest by latest activity. Pills filter it by type (issues, pull
    requests), status (open, running, needs attention, closed) and repo,
    each with its count; a box finds a number. Selecting one opens its
    whole D1 transition log beside the list (under it on a narrow screen):
    time, event, from, effect, routine, mode, delivery, dropped reason,
    newest first, under its live status. Every filter and the selection
    are in the URL (`?type= &status= &repo= &n= &open=owner/repo/N`), so a
    view can be shared, and survives the 30-second refresh
  - `/status/repo?repo=…`: the repo's controls (below) and its
    repository-level activity (`control_changed` rows)
- **Kind and title:** `items` in D1 (`migrations/0006_items.sql`), filled
  from every webhook that carries an issue or PR: whether it's an issue or
  a PR, its title, its GitHub state. Display only. An item whose webhooks
  all came before it has no title, and its kind is guessed from PR-only
  events, else shown as "Issue or PR", until its next event.
- **Scripts:** `Authorization: Bearer <tofu output -raw status_secret>`,
  and `?format=json` gives the rows.
- **Per-repo controls:** `repo_controls` in D1
  (`migrations/0005_repo_controls.sql`, `src/controls.ts`), switched on a
  repo's settings page. No row means on. Each change records who and when,
  and logs a `control_changed` row (issue 0) to `transitions`. A change
  must be a POST from the dashboard's own origin, by a signed-in person or
  the Bearer key.
  - **`sweep`:** off, and the Scheduler skips that repo
    (`SweepSummary.paused`). If it can't read the switches it sweeps
    nothing that time, rather than a repo someone turned off.
  - More controls (an agent or routine each) are one entry in `CONTROLS`
    plus the place that reads it.
- **Setting up sign-in:** it goes through the Worker's GitHub App
  (`src/auth.ts`), so there's no second OAuth app. In the App's settings:
  1. General -> Callback URL: `tofu output -raw sign_in_callback_url`.
  2. Permissions -> Account permissions -> Email addresses: Read-only (how
     the Worker reads a person's verified emails).
  3. General -> Client secrets -> Generate a new client secret.
  4. Set `github_app_client_id` (General -> Client ID) and
     `github_app_client_secret` in `terraform.tfvars`, and apply.

  The Worker checks the domain itself, on its own server, then signs its own
  session cookie (`SESSION_SECRET`, generated by tofu); the GitHub token is
  used once and dropped. The same shape as the Umbraco AI Academy's gate,
  which does it with Google.
- **The table:** `issue_status` in D1 (`migrations/0004_issue_status.sql`),
  one row per open issue, written by each issue's DO:
  - an enforced rule that applies, or a sweep re-fire, upserts it. A fire
    starts a new run (step cleared), and the attempt counts on while it's
    the same routine as last time
  - a heartbeat sets the step; a completion signal marks it not running
  - a CI-fix rework sets the count
  - a close (the Worker's, a person's, a PR's `Closes #`) deletes it, as
    does a rule that leaves no tracked label and fires nothing
- **Side effect only:** nothing reads it to decide anything, and a failed
  write is logged, never failing the transition. Shadow events don't write
  it (their labels never moved), so a shadow repo has no rows.
- **Refreshes itself every 30 seconds** (a meta refresh), no push. An issue the Worker
  first sees after this deploy gets its row on its next transition.

## The watchdog is a real event

A watched routine that never reports back now moves the issue through the
reducer like any other fact, rather than only leaving a comment. When the
alarm fires, `coordinate.ts`'s `coordinateWatchdogExpired` raises
`watchdog_expired` against the live labels, and `graph.ts`'s table moves
the issue to **`ai-stuck`** from any state a watched routine can leave it
in (`ready-for-ai`, `auto-release`, `auto-rework`, `auto-merge`, plus
post-swap `generated-by-ai`/`ai-blocked` for a build that swapped its label
but never posted its outcome). It also comments (quoting the last heartbeat
step if there was one) and logs the transition to D1.

- **What gets watched is decided by the table.** A fired routine only arms
  the watchdog if its target state has a `watchdog_expired` rule
  (`graph.ts`'s `isWatched`). `issue-discuss-loop` never posts an outcome,
  so `ai-discuss` has no such rule, and discussions no longer raise a
  false alarm 30 minutes after every fire.
- **Two ways out of `ai-stuck`.** A late, authoritative outcome still wins,
  and a human re-adding the trigger label retries that loop. A slow routine
  that finishes after the watchdog usually swaps its own label first, which
  leaves `ai-stuck` plus e.g. `generated-by-ai` on the issue. `deriveState()`
  reads that one pairing as `ai-stuck` rather than `ambiguous`. Any other
  pair of tracked labels is still ambiguous.
- **Retry-safe ordering.** Cloudflare retries a throwing `alarm()` with
  backoff, so `pendingFire` is cleared last. The old handler deleted it
  first, so one failed comment call meant every retry found nothing and the
  alert was lost. A retry can now post a duplicate comment, but never drops
  the alert.

## Shadow mode (Phase 3)

`MODE` (a `wrangler.toml` var, `"shadow"` by default) decides whether the
Worker writes anything. Only the exact string `"enforce"` does; unset or a
typo is shadow (`coordinate.ts`'s `resolveMode`), so the Worker can't start
writing labels next to loops that still swap their own.

In shadow, `shadowDeps()` makes `addLabel`/`removeLabel`/`closeIssue`/
`commentOnIssue`/`fireRoutine` no-ops. Everything else is real: label and
merge-gate reads, dedupe, `pendingFire`, the D1 row. So the watchdog still
arms when a routine would fire, and an expiry logs `watchdog_expired`
(without commenting). That counts real routines that never reported back.
Every D1 row carries its `mode` (`migrations/0002_transitions_mode.sql`).

`.dev.vars.example` sets `MODE=enforce`, because the mock scenarios above
check that the mock's labels changed. Delete that line for a local shadow
run-through. An existing `.dev.vars` without the line is now shadow.

Phase 3's two numbers (07-build-phases.md), after a run-through:

```sql
-- 1. The current system fired, but the table says it shouldn't have.
--    loop-dispatch fires on any trigger label, so a dropped labelled_* row
--    is a fire the reducer would have blocked.
SELECT event, from_state, COUNT(*) FROM transitions
WHERE mode = 'shadow' AND event LIKE 'labelled_%' AND dropped_reason IS NOT NULL
GROUP BY event, from_state;

-- 2. Gaps in the table: non-trigger events with no matching rule.
SELECT event, from_state, COUNT(*) FROM transitions
WHERE mode = 'shadow' AND event NOT LIKE 'labelled_%' AND dropped_reason IS NOT NULL
GROUP BY event, from_state;

-- Bonus: routines that never reported back.
SELECT from_state, COUNT(*) FROM transitions
WHERE mode = 'shadow' AND event = 'watchdog_expired' GROUP BY from_state;
```

Webhooks `translate()` doesn't recognise at all leave no row. Neither do
**contextual events** (`graph.ts`'s `CONTEXTUAL_EVENTS`: pushes, merges,
comments, closes and trigger-label removals) outside the states where they
mean something. A push to a PR that isn't in `auto-rework` is ordinary
activity, not a gap. The watchdog's timeout is per routine
(`coordinate.ts`'s `watchdogMinutesFor`: release 60 min, build 60,
others 30, set from real run times by `queries/routine-durations.sql`). Run 1's numbers and the fixes they led to are in
[13-shadow-results.md](../docs/agent-orchestration/13-shadow-results.md).

## Enforcing (Phase 4)

`MODE=enforce` (tofu `mode`) makes every event real: the Worker fires the
repo's loop-dispatch routine (`REPO_ROUTINES_JSON`) and applies its label
writes. The one exception is the watchdog, which has its own `WATCHDOG`
switch (tofu `watchdog`, default shadow) because its timeouts are still
guesses (`coordinate.ts`'s `resolveEnforced`). Each D1 row records its own
`mode`, so watchdog rows stay `shadow` until it's switched on.

A repo moved to the Worker is a clean break: its old edge (the loop-dispatch
caller workflow) is **deleted**, so the Worker is its only dispatcher. The
shared reusable `loop-dispatch.yml` and `route-event.sh` stay until every
repo has moved, because the remaining repos' callers load them from `main`
on every event.

`umbraco-mcp-ops` switched over (30-09-2026) by deleting
`loop-dispatch-caller.yml`. Label and comment events run the caller from the
default branch, so that deletion only takes effect when it reaches `main`.

**Never let the Worker and the old caller both fire.** loop-dispatch's
re-check doesn't protect against two fires at once: both sessions start
before either has changed anything, so a `ready-for-ai` would get two builds
(two PRs) and an `ai-discuss` two replies. The cutover closes that window:

1. In `terraform.tfvars`: fill in `repo_routines` (Fire URL + token), set
   `mode = "enforce"`, and give `github_read_token` Issues + Pull requests
   **write** (enforced rules remove labels and close). `tofu apply`.
2. **Straight away**, disable the old caller, and don't label anything
   between steps 1 and 2:
   `gh workflow disable "loop-dispatch (caller)" --repo <owner>/<repo>`
   (in other repos the caller is `.github/workflows/loop-dispatch.yml`).
3. Delete the caller: release to `main` here, or a PR in the other repo.
   The disable was only the bridge until then.

Check it with a throwaway `ai-discuss` issue: exactly one reply, and a
`mode = enforce` row in D1.

To undo: re-enable the caller workflow (or restore the file) first, and in
the same breath set `mode` back to shadow and apply.

For another repo: add its `repo_routines` entry and webhook, then the same
three steps.

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
- **`/fire/<name>` (the kickoff fire) is still a no-op log-and-200 stub**
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
  with a pending fire, and asserted to post the real comment, swap to
  `ai-stuck`, log to D1 and clear state (plus a no-op case with nothing
  pending, and a failing-call case that keeps state) — genuine coverage of
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
- The Worker writes as its **GitHub App's bot** (`src/github-app.ts`:
  an RS256 JWT, exchanged per repo for an installation token, cached until
  shortly before it expires). The **self-trigger guard** is
  `translate(payload, { botLogin })`: label changes the bot made come back
  as webhooks and are dropped. The bot login is the App's `<slug>[bot]`,
  looked up once per isolate. So the CI-fix cycle's rules (`auto-merge` →
  `auto-rework` → `auto-merge`) fire rework-loop and merge-flow directly
  instead of through their echo. Tofu requires the App, because those rules
  would fire twice with an identity the guard can't recognise. The attempt
  count (`ciFix`, capped at `MAX_CI_FIX_ATTEMPTS`) lives in DO storage and
  resets when a human re-adds `auto-merge` after `merge-blocked`.
- **Private repos work through the App.** The merge gate reads CI through
  the check-runs API. A fine-grained personal token has no Checks
  permission, so on a private repo it got 403. The GitHub App has
  Checks: read. The full e2e suite passed 25/25 with the sandbox private
  (02-10-2026). Only the fallback personal token is still public-only.
