---
name: mcp-issue-loop
description: >-
  Work the open GitHub issues labelled `ready-for-ai` in an Umbraco MCP repo, driving each
  to a CI-green, mcp-reviewed PR — then hand off (human change-requests → rework-loop, merge
  → merge-flow). Two modes: LOCAL — orchestrated, one hook-backed git worktree + build
  subagent per issue (max 3 parallel), capture hooks; CLOUD — one event-triggered session
  per issue, no worktree. Both boot a local Umbraco (worker-env), gate on local tests before
  pushing, and run the mcp-review skill (5-lens code review + security scan) over the PR.
  This loop never responds to human reviews and never merges. Repo-agnostic across Umbraco
  MCP repos; github-ops required. Trigger on "work the ready issues", "run the issue loop",
  or a routine on Issue: Labeled `ready-for-ai` (cloud).
---

# mcp-issue-loop

A durable loop that turns the `ready-for-ai` GitHub backlog into merged PRs.

**Two modes, set by the caller** (default **local**; a routine states **cloud mode**
explicitly):
- **Local (orchestrated)** — a long-lived loop over the whole backlog: one hook-backed
  worktree + build subagent per issue (cap 3), capture hooks running. Everything from
  *Config* through *Rules* below.
- **Cloud (one-shot per issue)** — a routine fires once per `ready-for-ai` issue
  (cross-issue parallelism comes from separate sessions); no worktree. See
  [Cloud mode](#cloud-mode).

**Both modes end the same way:** each issue reaches a **CI-green PR that `mcp-review` has
passed**, then you **stop and hand off**. Human change-requests are actioned by
[`rework-loop`](../rework-loop/SKILL.md) (the reviewer adds the `auto-rework` label);
merging is `merge-flow`'s job (`auto-merge` once approved). **This loop never responds to
human reviews and never merges** — there is no review-response phase here.

In **local mode** you are the **orchestrator**: a loop (surviving across turns / wake-ups)
whose terminal condition is *every open `ready-for-ai` issue has a CI-green, mcp-reviewed PR
handed off, or is blocked-with-a-comment*. You reach it by dispatching **one build subagent
per issue, each in its own git worktree** (cap **3**), then driving each returned PR's CI
green and reviewing it with `mcp-review`. Each issue's lifecycle is **build → CI-green →
review → hand off**:

1. **Build** — finite, autonomous, parallel (cap 3). A subagent implements the issue, tests
   locally, pushes, and opens a PR — it does **not** poll or wait on CI. See
   [`references/issue-lifecycle.md`](references/issue-lifecycle.md).
2. **CI-green** — once a subagent returns an open PR, **you** poll its check-run status
   until every check passes or the 8-attempt cap trips, re-dispatching a subagent into that
   same worktree with a failing check's log to fix the root cause on any failure.
3. **Review** — you run `mcp-review` over the CI-green PR and fix any findings (re-testing
   locally, re-greening CI). Once clean/addressed, swap the issue's outcome label. Then hand
   off — the human reviews, `rework-loop` handles their change-requests, `merge-flow` merges.

Steps 2 and 3 both live in [Step 3](#step-3--build-ci-and-review-rolling-cap-3) below.

`/goal` keeps the loop alive across build/CI waits — set it in Step 2, clear it when every
issue is handed off or blocked.

## Config (resolve once, up front)

| Thing | How to resolve | Default |
|-------|----------------|---------|
| Repo | identify the current repo (github-ops → *Detect base branch / repo*) | current repo |
| AI label | fixed | `ready-for-ai` |
| Base branch | detect via the `release-and-branching` skill (gitflow → `dev`) | `dev` |
| Concurrency cap | fixed | **3** |

This skill assumes an **Umbraco MCP repo**, in either of its two shapes. Confirm the
repo looks like one — a `CLAUDE.md` and worktree hooks in `.claude/settings.json`, plus:

| Shape | Marker | Notes |
|---|---|---|
| **Server repo** — the `@umbraco-cms/mcp-*` family | `src/umbraco-api/tools/` | The common case. |
| **SDK monorepo** — `umbraco/Umbraco-MCP-Base` | `packages/mcp-server-sdk` | Also `packages/hosted-mcp`, `packages/create-mcp-server`, `template`, and `plugins/umbraco-mcp-skills`. **Use this loop even for a skills-only change** — the repo has a real toolchain, so the content loop's playbook doesn't fit. |

If it matches neither, stop and say so — the build playbook's MCP/test conventions
won't apply. (A repo with no build/test toolchain at all — the ops repo, docs repos —
belongs to [`content-issue-loop`](../content-issue-loop/SKILL.md).)

**Don't assume the repo's scripts.** The two shapes don't share script names: server
repos have `npm run test:all` / `test:changed` / `start:umbraco`; the SDK monorepo has
`npm test`, `test:integration`, `test:e2e`, `test:template`, `test:cli`, and builds with
`npm run build` / `build:all`. **Read `package.json`** and use what's actually there.

**GitHub operations** (list issues, open/merge PRs, check CI, read failing logs,
etc.) go through the **`github-ops`** skill — name the *operation*, never a raw `gh`
command. **`github-ops` must be installed for this loop to run.**

## Step 1 — gather the backlog

**List** the open issues labelled `ready-for-ai` on the repo (github-ops → *List
issues by label / state*), reading each one's number/title/body.

- No matching issues → report "nothing labelled `ready-for-ai` is open" and stop.
  (If the label doesn't exist yet on the repo, say so — someone has to create and
  apply it before this loop has anything to do.)
- Otherwise build a queue of `{number, title, body}`. Announce the queue to the
  user (numbers + titles) before dispatching anything.

## Step 2 — set the goal

Set the durable terminal condition so the loop persists across turns / wake-ups.
Make it **satisfiable** — every issue reaching a *terminal* state, not every issue
merged (a blocked issue or an un-reviewed PR must not keep the loop alive forever):

```
/goal every open ready-for-ai issue in <repo> is terminal — a CI-green PR that mcp-review passed and handed off (rework-loop owns human change-requests, merge-flow owns merging), or blocked-with-a-comment — and no actionable work is left in the queue
```

Clear it with `/goal clear` when the goal is met or you abort. See
[Stop conditions](#stop-conditions) for exactly when the loop ends.

## Step 3 — build, CI, and review (rolling, cap 3)

Dispatch a **build subagent per issue**, at most 3 running at once. Dispatch the
first 3 in a single message (parallel); each subsequent dispatch happens when a
running one completes and frees a slot.

For each issue, spawn a subagent (`agentType: general-purpose`, background) whose
prompt is the **build playbook** in
[`references/issue-lifecycle.md`](references/issue-lifecycle.md) with the issue's
number/title/body substituted in. Do **not** pass `isolation: worktree` on the
Agent call — the subagent creates the project's *hook-backed* worktree itself
(via `EnterWorktree`), which the generic isolation would bypass.

**You choose the model per issue** — see [Model selection](#model-selection).
Triage the issue's scope and pass the fitting tier as the Agent `model`.

Track each subagent's result:
`{issue, worktreeName, worktreePath, branch, prNumber, model, tier}`.
A build subagent's job is done when its PR is open — it does not poll CI or block on it.

**Driving CI green happens here, on the orchestrator/main thread, not inside the
subagent.** Once a subagent returns an open PR, poll its check-run status (github-ops →
*Get PR CI / check-run status*) until every check passes or the **8-attempt cap** trips. On
a failing check, read the log (github-ops → *Read a failing check's log*) and
**re-dispatch a subagent into that same worktree** with the log to fix the root cause,
re-test locally, re-push, and re-check — the same shape as the `mcp-review` fix cycle
below, just triggered by a failing check instead of a review finding. Never re-push an
identical fix that already failed (**no-progress guard**).

Once CI is green, **run [`mcp-review`](../mcp-review/SKILL.md) over that PR** (the faithful
5-lens + security scan). **The build subagent does not review its own code** — running the
review here, at the orchestrator level, is what makes it independent. If it raises
findings, fix them (re-dispatch into that worktree, or fix inline), then **re-run the local
tests before pushing** — all testing is local (the worktree's Umbraco + the diff's tests /
suite), and the review→fix cycle must re-test locally and only then re-green CI, never
leaning on CI to catch a fix's regressions. Only once `mcp-review` is clean/addressed do the
**outcome-label swap**: remove `ready-for-ai`, add `generated-by-ai`, and comment the PR
link on the triggering issue (github-ops → *Add / remove a label* and *Comment on an
issue*) — the swap is what marks the issue done, so it must wait until review is actually
finished, not just CI.

If a build subagent reports it could not finish (e.g. the issue is genuinely ambiguous), or
the CI-green cap or no-progress guard trips while driving CI **or** while fixing an
`mcp-review` finding, record the issue as **blocked**: remove `ready-for-ai`, add
`ai-blocked`, and comment the specific reason (the last failing CI log, the ambiguity, what
was tried) — that outcome swap is yours too now; don't let one bad issue stall the queue.

Keep dispatching until the queue is empty, all build subagents have returned, every PR's CI
is green (or the issue is blocked), and each green PR has been through `mcp-review` and had
its outcome label swapped.

## Step 4 — hand off (no human-review phase here)

Once an issue has a CI-green PR that `mcp-review` passed, it's **done in this loop**.
**Human reviews are actioned by [`rework-loop`](../rework-loop/SKILL.md), not this one.** Do
not watch for the human's review, respond to change-requests, or merge:

- **Human change-requests** → the reviewer leaves comments and adds the `auto-rework` label,
  which fires `rework-loop`. This loop has no review-response phase and dispatches no
  response subagents.
- **Merging** → `merge-flow`'s job, via the `auto-merge` label once the PR is approved.

So after Step 3, hand the worktree back if the repo wants it cleaned up (or leave it for
`rework-loop`), report the tally (handed-off PRs, blocked issues), and `/goal clear`. The PR
is ready for review; the human drives it from there.

## Model selection

The **orchestrator decides the model per subagent** — it has read each issue, so
it triages scope and picks the tier that fits, rather than paying top-tier for a
copy tweak or under-powering a new collection. The orchestrator itself always
**inherits the session model** (don't pin it) — it's coordination and judgment,
and pinning would fight `/model` and the cloud routine's configured model.

Triage each issue at dispatch and pass the tier as the Agent `model`:

| Scope of the issue | Model |
|---|---|
| **Complex** — new tool collection, cross-cutting change, block-editing / tricky domain logic, anything with subtle correctness or many tools | `opus` |
| **Standard** — add or change one tool with its tests/evals, a focused bug fix in existing code | `sonnet` |
| **Trivial, code-touching** — a one-line fix, a schema tweak, a description change | `sonnet` |
| **Docs / non-code only** — README, comments, pure Markdown, no build/test impact | `haiku` (optional) |

**Floor:** never dispatch a code-touching issue below `sonnet`. `haiku` is only
acceptable for genuinely non-code work. When unsure, round **up** a tier — an
over-powered build is cheaper than a blocked one.

**Never use `fable` — for any subagent, any issue, any tier.** It is not a valid
choice in this loop.

(Human-review responses aren't modelled here — they're `rework-loop`'s, which picks its own
model.)

The tier names resolve to the current model in each family, so the skill doesn't
go stale as versions advance. Valid choices here are `opus`, `sonnet`, and
`haiku` only — `fable` is never used (see the floor above).

## Stop conditions

The loop ends when **no actionable work remains**. Actionable work = a queued issue, a
running build subagent, a returned open PR whose CI isn't green yet, or a CI-green PR not
yet run through `mcp-review`. When none of those exist, every remaining issue is terminal:
**handed off** (a CI-green, mcp-reviewed PR — the human, `rework-loop`, and `merge-flow`
take it from here) or **blocked** (labelled `ai-blocked` with a comment). This loop does
**not** wait on human review — that's `rework-loop`'s trigger, not a state this loop sits
in.

- **Local / interactive** → once every issue is handed off or blocked, stop. `/goal clear`
  and hand back a summary: what's handed off, what's blocked and why.
- **Cloud** → one-shot per issue (see [Cloud mode](#cloud-mode)); stop at the handed-off PR.

**Safety backstops (all modes) — stop touching an issue, label it `ai-blocked`
(remove `ready-for-ai`, comment why — see [Step 3](#step-3--build-ci-and-review-rolling-cap-3)
above), and hand back if any trips:**

- **CI-green cap** — at most **8** attempts to green one PR's CI. After that, the
  issue is `ai-blocked` (comment the last failure).
- **No-progress guard** — never retry the same failing command/action verbatim.
  If a CI-fix, build, or review-fix pass produces no new state, treat the issue as
  blocked rather than looping.
- **Global backstop (unattended)** — bound total wake-ups / dispatches (or a wall-
  clock/date limit). When it trips, `log` what was left undone — never silently
  drop issues.
- **Label / issue changes** — if the `ready-for-ai` label is removed or the issue
  is closed mid-flight, drop it from the loop immediately.

## Capturing learnings (compounding)

The loop feeds its own improvement by emitting **proto-learnings** — raw
observations that *something is worth improving somewhere* — which a separate
scheduled routine (Loop B) later triages into PRs. This half only **captures**;
nothing here (or in any subagent) ever edits skills or `CLAUDE.md` inline.

**Capture is fully automatic and hook-driven — neither you nor the subagents file
anything by hand.** Two async hooks (shipped by this plugin) do it off the
critical path:

- **`SubagentStop`** → after each issue subagent finishes, an analyzer reads its
  transcript and appends a `proto-learning` row if something non-obvious
  happened at the **issue level** (a diagnosed CI failure, a repeated mistake, an
  unclear/missing pattern, a repo gotcha, a blocker).
- **`SessionEnd`** → once, at the end of the orchestration session, an analyzer
  reads *this* session's transcript and appends **loop-level** learnings you're
  the only one positioned to reveal: a backstop that tripped, a class of issue
  that consistently needed `opus`, an `mcp-review` finding that recurs across
  issues, a recurring blocker.

Properties that make this the capture mechanism (vs. self-reporting): it **can't
be skipped** (fires even if a subagent crashes), it's **unbiased** (a fresh
analyzer reads the transcript, not the agent grading itself), and it's **off the
critical path**. Proto-learnings are rows on the shared **"MCP Loop Learnings"
Slack canvas** (`#mcp-ops-learning`) — the plugin is read-only and may run on a
stateless runner, so it can't store them itself, and a GitHub-issue inbox turned
out to silently lose captures across the org boundary between an `umbraco/*`
repo and the ops repo (see the schema doc for why). The analyzer appends the row
itself, given one narrow Slack write tool. The analyzers enforce **signal, not
noise**: one row only when something non-obvious happened; nothing for a clean
run. See `hooks/` and the [schema](references/proto-learning-schema.md).

So: **do the work well and let the hooks capture.** Your only capture-related duty
is *not* to fix learnings inline — leave that to Loop B.

## Rules

- **Never touch an issue without the `ready-for-ai` label.** The label is the
  only gate. If a human removes it mid-flight, stop work on that issue. The one
  exception is the **outcome swap**: the loop itself removes `ready-for-ai` and adds
  `generated-by-ai` (green PR) or `ai-blocked` (backstop tripped) — this is now the
  orchestrator's own step (see [Step 3](#step-3--build-ci-and-review-rolling-cap-3) above), not
  the build subagent's — and it's the loop finishing the issue, not a human pulling the
  gate.
- **One worktree per issue, hook-backed.** Always create via `EnterWorktree`
  (fires this repo's `WorktreeCreate` hook: fresh DB, `.env`, dynamic port,
  `npm install`). Never hand-roll `git worktree add` and never use the Agent
  tool's generic `isolation: worktree` for these repos.
- **Build subagents are finite; the orchestrator owns the build/CI waits.** A subagent
  returns once its PR is open — it does not poll or wait on CI; the orchestrator drives CI
  green after it returns (see Step 3). This loop never waits on a human review at all —
  that's `rework-loop`'s trigger. The waits that live under `/goal` are build + CI, not
  human ones.
- **Reviews are non-negotiable — and run at the top level, honestly reported.** Every
  buildable PR is reviewed with [`mcp-review`](../mcp-review/SKILL.md) — the faithful 5-lens
  code review + security scan — run by **you, the orchestrator**, never by the build subagent
  (a subagent can't spawn the review fan-out, and self-review is weak). Do **not** use the
  bundled `/security-review` / `/code-review` slash commands: they're
  `disable-model-invocation: true`, so a subagent or headless routine can't run them — they
  reach the model as inert text and the review silently never happens. Report only what
  `mcp-review` actually found; never claim a review passed that didn't run.
- **Follow the repo, not this skill, for specifics.** Test/build commands, the
  version-bump file list, and worktree cleanup live in the repo's `CLAUDE.md`
  and the `release-and-branching` skill — obey those.
- **Recap as you go.** After each dispatch, each subagent completion, each `mcp-review`,
  give a one-line status (queue depth, in-flight issues, PRs handed off).
- **Capture, never fix.** Learnings are appended as `proto-learning` canvas rows
  (see [Capturing learnings](#capturing-learnings-compounding)); the triage
  routine turns them into PRs. Do not edit skills or `CLAUDE.md` from inside
  this loop.

## Cloud mode

Everything above (Config → Rules) is **local mode**. **Cloud mode** is set explicitly by
the caller — the routine prompt says *run in cloud mode*. It's **event-triggered, one
session per `ready-for-ai` issue**, so there's **no cap-3 queue and no worktrees** —
cross-issue parallelism comes from separate sessions firing. The session is a **thin
orchestrator on a cheap base model**: it triages the one issue and dispatches a **single**
build subagent on the best-fit model — the same *Model selection* logic as local, just one
subagent instead of up to three.

**Know the environment first.** Before triaging, consult the **[`worker-env`](../../../loop-dispatch/skills/worker-env/SKILL.md)** skill
(`cat /root/env-manifest.md`) — it tells you what this cloud worker provides (.NET SDK,
whether SQL Server is available, the ops `run-umbraco.sh`). Cloud sessions **do** get a
local Umbraco now: the build subagent boots one and runs a real local test gate (below) —
this is no longer a compile-only, CI-is-the-only-gate flow. Run these sessions in a **SQL
Server** worker-env so the local run is **CI-parity** — the subagent tests on the same
provider CI uses, greens the suite locally, and skips the slow push → CI-fail → fix →
re-push loop. (SQLite is a degraded fallback only — a different provider that throws
false failures and false passes; see step 2.)

For the one triggering issue (identify it from the event; if unclear, take the **oldest**
open `ready-for-ai` issue; none → quiet no-op):

1. **Triage + dispatch.** Read the issue, pick its tier from
   [Model selection](#model-selection) (`opus` / `sonnet` / `haiku`; never `fable`; floor
   `sonnet` for code-touching work), and spawn **one** build subagent on that model
   (Agent/Task tool with the chosen `model`). The base session stays on a cheap model — it
   only triages, dispatches, and reports. *If the routine environment can't spawn a
   subagent with a model override, do the build **inline** on the routine's own model
   instead (set that to a sensible default, e.g. `sonnet`) and note it.*
2. **Build (in the subagent).** Work **directly in the session's checkout** — no
   `EnterWorktree` (cloud sessions are already isolated, and the worktree hooks need the
   local DB/toolchain). Implement the issue following the **shared build playbook**
   ([`references/issue-lifecycle.md`](references/issue-lifecycle.md)) and the MCP skills,
   with two substitutions for playbook steps 1 and 4:
   - **Instead of the worktree (playbook step 1):** work directly in the session checkout.
   - **Instead of `npm run start:umbraco` + `npm run test:all` (playbook step 4):** bring up
     a local Umbraco via the **[`worker-env`](../../../loop-dispatch/skills/worker-env/SKILL.md)**
     skill and run a local test gate **on SQL Server**. As your **first action** (so Umbraco
     boots while you implement — first boot runs the unattended install, ~1–2 min):
     ```
     bash /root/.umbraco-ops/run-umbraco.sh --provider sqlserver >/tmp/umbraco-run.log 2>&1 &
     ```
     **Default to SQL Server** — it's the provider CI uses, so the results are trustworthy.
     **SQLite is a last resort**, not an equivalent: it's a different provider and produces
     provider-specific false failures *and* false passes. Use `--provider sqlite` only when
     `worker-env` reports no mssql image (a sqlite-only env), or for a quick smoke of a single
     focused change where speed matters — and in either case its results aren't authoritative:
     confirm anything surprising on SQL Server, and treat CI as the real gate. Implement, then **wait for Umbraco
     ready** (`.demo-site-port` exists and `/umbraco/management/api/v1/server/status` returns
     200) and run:
     - **`npm run test:changed`** — the integration tests touching your diff. The **default
       gate** for a focused change. If the repo doesn't have that script yet, fall back to
       `npm run test:one -- --testPathPattern='<collection>/__tests__/<tool>'` for each area
       you touched.
     - **`npm run test:all`** — the full suite. Run it **when you suspect the change reaches
       beyond its diff** — a shared helper, a schema/generated-client change, cross-cutting
       logic, or `test:changed` surfacing something that hints at wider breakage. For an
       obviously self-contained change, don't pay the full-suite cost — `test:changed` is
       enough.

     Fix locally until green **before** pushing. Because the local run is SQL Server
     (CI-parity), a green local gate means CI passes first time — much quicker than pushing
     and looping on remote CI failures (the 8-attempt cap).
   - **The build subagent does NOT review its own code, and does NOT drive CI.** No
     `/security-review` / `/code-review` here — those slash commands can't run in a
     subagent anyway, and self-review is weak. Once local tests are green, **commit, push,
     and open the PR** against `<base>` (github-ops → *Create a PR*), linking the issue
     (`Closes #N`), ready for review, not draft — then **return**. Driving that PR's CI
     green (step 3) and reviewing it with `mcp-review` (step 4) are the **base session's**
     job, not yours — you do not poll CI or wait for review.
3. **Drive CI green — from the base session, not the subagent.** Once the build subagent
   returns an open PR, poll its check-run status (github-ops → *Get PR CI / check-run
   status*) until every check passes or the **8-attempt cap** trips. Since you tested on SQL
   Server (CI-parity), CI should pass first time — this is usually just a confirmation, not a
   fix loop; a surprise CI failure usually means the local run was on SQLite or the diff
   wasn't fully covered by `test:changed`. On a failing check, read the log (github-ops →
   *Read a failing check's log*) and **re-dispatch a subagent into that same checkout** with
   the log to fix the root cause, re-test locally, re-push, and re-check. Never re-push an
   identical fix that already failed (no-progress guard).
4. **Review the PR with `mcp-review` — from the base session, not the subagent.** Once CI
   is green (step 3), the **base session** runs the
   **[`mcp-review`](../mcp-review/SKILL.md)** skill over that PR (the faithful 5-lens code
   review + security scan). It spawns its own review subagents, so it must run here at the
   top level — that's also what makes it an *independent* reviewer rather than the author
   grading itself. Fix any surviving findings (dispatch a fix on the build subagent's model,
   or fix inline), then **re-run the local tests before pushing** (the same local SQL Server
   gate from step 2 — the review→fix cycle re-tests locally, never leaning on CI), re-green
   CI, and **report only what mcp-review actually found** — never claim a review passed that
   didn't run.
5. **Mark the issue complete, then stop at the CI-green PR.** Once CI is green **and
   mcp-review is clean/addressed**,
   do the **outcome-label swap** on the triggering issue — remove `ready-for-ai`, add
   `generated-by-ai`, comment the PR link. Removing `ready-for-ai` is what stops this
   routine re-firing on the same issue. Then **stop**: do **not** enter a review phase and
   do **not** merge — review-response is [`rework-loop`](../rework-loop/SKILL.md)'s job (it
   fires on the PR-review event), and merging is `merge-flow`'s.

**Not used in cloud mode:** the cap-3 queue, worktrees, and the review-response phase. The
**capture hooks** (SubagentStop/SessionEnd → `proto-learning` canvas rows) *are* delivered to
cloud sessions by the [`cloud-skill-sync`](../../../../scripts/cloud-skill-sync/) setup
script, so self-learning capture runs in cloud too — the analyzer appends to the canvas
directly (its one Slack write tool) wherever it runs, local or cloud; it logs and skips
only if `jq`/`claude` is missing or the transcript isn't readable. The same guardrails still hold —
`ready-for-ai` is the only gate, reviews are non-negotiable, follow the repo's `CLAUDE.md`,
never leave CI red, and a blocked issue gets labelled `ai-blocked` + a comment, then stop.
