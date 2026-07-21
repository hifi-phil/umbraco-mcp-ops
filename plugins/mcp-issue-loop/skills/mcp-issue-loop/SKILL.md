---
name: mcp-issue-loop
description: >-
  Work through the open GitHub issues labelled `ready-for-ai` in an Umbraco MCP
  repo, driving each to a CI-green PR. Two modes, chosen by the caller (default
  local): LOCAL — orchestrated, one git worktree + subagent per issue (max 3
  parallel), local tests, then a review-response loop until merged, with capture
  hooks; CLOUD — one session per issue (event-triggered), no worktree, TypeScript
  compile sanity + CI as the test gate (no local Umbraco), build to a CI-green PR
  and stop (review-response handed to rework-loop). Each issue is implemented
  following the established MCP skills and security/code-reviewed. Repo-agnostic
  across Umbraco MCP repos; github-ops required. Trigger on "work the ready issues",
  "run the issue loop", or a routine on Issue: Labeled `ready-for-ai` (cloud).
---

# mcp-issue-loop

A durable loop that turns the `ready-for-ai` GitHub backlog into merged PRs.

**Two modes, set by the caller** (default **local**; a routine states **cloud mode**
explicitly):
- **Local (orchestrated)** — you own a long-lived loop over the whole backlog: one
  hook-backed worktree + subagent per issue (cap 3), a build phase then a
  human-review-response phase, capture hooks running. That's everything from *Config*
  through *Rules* below.
- **Cloud (one-shot per issue)** — a routine fires once per `ready-for-ai` issue
  (cross-issue parallelism comes from separate sessions); you build that **one** issue
  to a CI-green PR with **CI as the test gate**, then **stop**. See [Cloud mode](#cloud-mode).

In **local mode** you are the **orchestrator**. You own a long-lived loop (it survives
across turns and scheduled wake-ups) whose terminal condition is: *every open
`ready-for-ai` issue in this repo has a PR that CI passed, that the human reviewed, and
that is approved + merged.* You reach that state by dispatching **one subagent per
issue, each in its own git worktree**, capped at **3 running at once**.

Each issue has a two-part lifecycle:

1. **Build phase** — finite, autonomous, parallel (cap 3). A subagent implements
   the issue, reviews it, pushes, greens CI, and opens a PR. See
   [`references/issue-lifecycle.md`](references/issue-lifecycle.md).
2. **Review phase** — long-lived, human-gated. You (the orchestrator) watch each
   PR for the human's review and, when changes are requested, dispatch a
   response subagent that addresses the feedback, re-greens CI, and re-requests
   review. Repeats until the PR is approved and merged.

`/goal` is what keeps the loop alive between wake-ups and human waits — set it in
Step 2 and only clear it when the whole backlog is done (or you abort).

## Config (resolve once, up front)

| Thing | How to resolve | Default |
|-------|----------------|---------|
| Repo | identify the current repo (github-ops → *Detect base branch / repo*) | current repo |
| AI label | fixed | `ready-for-ai` |
| Base branch | detect via the `release-and-branching` skill (gitflow → `dev`) | `dev` |
| Concurrency cap | fixed | **3** |

This skill assumes an **Umbraco MCP repo** — the `@umbraco-cms/mcp-*` server
family. Confirm the repo looks like one (has `src/umbraco-api/tools/`, a
`CLAUDE.md`, worktree hooks in `.claude/settings.json`). If it doesn't, stop and
say so — the build playbook's MCP/test conventions won't apply.

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
/goal every open ready-for-ai issue in <repo> is in a terminal state — merged, or blocked-with-a-comment, or a CI-green PR awaiting the human's review with no unaddressed feedback — and no actionable work is left in the queue
```

Clear it with `/goal clear` when the goal is met or you abort. See
[Stop conditions](#stop-conditions) for exactly when the loop ends.

## Step 3 — build phase (rolling, cap 3)

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
A build subagent's job is done when its PR is open and CI is green. If a build
subagent reports it could not finish (e.g. the issue is ambiguous, or CI can't be
greened), record it as **blocked**, leave a comment on the issue explaining why,
and move on — don't let one bad issue stall the queue.

Keep dispatching until the queue is empty and all build subagents have returned.

## Step 4 — review phase (loop until approved + merged)

Now every buildable issue has an open PR. For each PR, the human reviews it and
you respond. This phase is cheap waiting punctuated by short bursts of work.

**Watch for reviews.** Poll each open PR for new review activity — its review
decision, review state, and CI/merge status (github-ops → *Get a PR* + *Get PR CI /
check-run status*).

Drive the wait with `ScheduleWakeup` (dynamic `/loop`) at a long interval
(e.g. 1200s+) rather than busy-polling — a human review can take hours or days.
On a hosted/cloud run this is the same shape: a scheduled routine that wakes,
checks review state, acts, and re-arms.

For each PR, react to its `reviewDecision`:

- **`CHANGES_REQUESTED`** (or new review comments) → dispatch a **review-response
  subagent** (see the response playbook in `references/issue-lifecycle.md`). It
  re-enters that issue's existing worktree with `EnterWorktree({ path })`,
  addresses every comment, re-runs the security + code review over the new
  changes, pushes, re-greens CI, replies to the review threads, and re-requests
  review. Only one response subagent per PR at a time, and only up to the
  review-round cap (see [Stop conditions](#stop-conditions)) — past that, hand the
  PR back for a human to resolve rather than ping-ponging.
- **`APPROVED`** → the human has accepted it. Merge per the `release-and-branching`
  skill (squash into `<base>` for gitflow repos), confirm the merge, then have
  the worktree removed (`ExitWorktree` remove, or the repo's `/cleanup`). Mark
  the issue done — the merge closes it if the PR/issue are linked; otherwise
  close it with a note linking the PR.
- **Still pending / no review yet** → do nothing; re-arm the wake-up.

Repeat until every PR is approved + merged (or explicitly blocked). Then the
`/goal` condition holds — report the final tally and `/goal clear`.

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

**Review-response subagents** reuse the tier the build subagent used for that
issue (carried in the tracking record). Bump **up** one tier if the human's
feedback is architectural or the change is proving harder than the build implied.

The tier names resolve to the current model in each family, so the skill doesn't
go stale as versions advance. Valid choices here are `opus`, `sonnet`, and
`haiku` only — `fable` is never used (see the floor above).

## Stop conditions

The loop ends when **no actionable work remains** — not only when everything is
merged. Actionable work = a queued issue, a running build/response subagent, or a
PR with unaddressed review feedback. When none of those exist, every remaining
issue is already terminal: **merged**, **awaiting the human** (CI-green PR, no new
feedback), or **blocked** (a comment left on the issue explaining why).

What happens at that point depends on run mode:

- **Local / interactive** → stop. `/goal clear` and hand back a summary: what
  merged, what's awaiting your review, what's blocked and why. Re-invoke the
  skill later to resume — any reviews you've since left get picked up. Don't sit
  polling for a human when the human is right there.
- **Cloud / unattended** → don't stop; go **dormant**. Re-arm the `ScheduleWakeup`
  at a long interval and re-check next tick. End the routine only when everything
  is merged or a backstop below trips.

**Safety backstops (all modes) — stop touching an issue, mark it blocked, and
hand back if any trips:**

- **CI-green cap** — at most **8** attempts to green one PR's CI. After that, the
  issue is blocked (comment the last failure).
- **Review-round cap** — at most **5** requested-changes rounds on one PR without
  reaching approval. After that, hand back — the disagreement needs a human.
- **No-progress guard** — never retry the same failing command/action verbatim.
  If a build or response pass produces no new state, treat the issue as blocked
  rather than looping.
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

- **`SubagentStop`** → after each issue subagent finishes, a read-only analyzer
  reads its transcript and files a `proto-learning` issue if something non-obvious
  happened at the **issue level** (a diagnosed CI failure, a repeated mistake, an
  unclear/missing pattern, a repo gotcha, a blocker).
- **`SessionEnd`** → once, at the end of the orchestration session, an analyzer
  reads *this* session's transcript and files **loop-level** learnings you're the
  only one positioned to reveal: a backstop that tripped, a class of issue that
  consistently needed `opus`, review-round churn, a recurring blocker.

Properties that make this the capture mechanism (vs. self-reporting): it **can't
be skipped** (fires even if a subagent crashes), it's **unbiased** (a fresh
analyzer reads the transcript, not the agent grading itself), and it's **off the
critical path**. Proto-learnings are **GitHub issues labelled `proto-learning` on
`hifi-phil/umbraco-mcp-ops`** — the plugin is read-only and may run on a stateless
runner, so it can't store them itself. The analyzers enforce **signal, not
noise**: one issue only when something non-obvious happened; nothing for a clean
run. See `hooks/` and the [schema](references/proto-learning-schema.md).

So: **do the work well and let the hooks capture.** Your only capture-related duty
is *not* to fix learnings inline — leave that to Loop B.

## Rules

- **Never touch an issue without the `ready-for-ai` label.** The label is the
  only gate. If a human removes it mid-flight, stop work on that issue. The one
  exception is the **completion swap**: on a CI-green PR the loop itself removes
  `ready-for-ai` and adds `generated-by-ai` (build playbook step 8) — that's the
  loop finishing the issue, not a human pulling the gate.
- **One worktree per issue, hook-backed.** Always create via `EnterWorktree`
  (fires this repo's `WorktreeCreate` hook: fresh DB, `.env`, dynamic port,
  `npm install`). Never hand-roll `git worktree add` and never use the Agent
  tool's generic `isolation: worktree` for these repos.
- **Build subagents are finite; the orchestrator owns the waiting.** A subagent
  must never sit and wait for a human review — it returns once its PR is green.
  All long waits (CI, human review) that span turns live in the orchestrator
  loop under `/goal`.
- **Reviews are non-negotiable.** Every build and every review-response pass runs
  both `/security-review` and `/code-review` (low) and fixes what they surface
  before pushing. See the playbook.
- **Follow the repo, not this skill, for specifics.** Test/build commands, the
  version-bump file list, and worktree cleanup live in the repo's `CLAUDE.md`
  and the `release-and-branching` skill — obey those.
- **Recap as you go.** After each dispatch, each subagent completion, each merge,
  give a one-line status (queue depth, in-flight issues, PRs awaiting review).
- **Capture, never fix.** Learnings are filed as `proto-learning` issues (see
  [Capturing learnings](#capturing-learnings-compounding)); the triage routine
  turns them into PRs. Do not edit skills or `CLAUDE.md` from inside this loop.

## Cloud mode

Everything above (Config → Rules) is **local mode**. **Cloud mode** is set explicitly by
the caller — the routine prompt says *run in cloud mode*. It's **event-triggered, one
session per `ready-for-ai` issue**, so there's **no cap-3 queue and no worktrees** —
cross-issue parallelism comes from separate sessions firing. The session is a **thin
orchestrator on a cheap base model**: it triages the one issue and dispatches a **single**
build subagent on the best-fit model — the same *Model selection* logic as local, just one
subagent instead of up to three.

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
   with two substitutions:
   - **No local Umbraco, no `npm run test:all`.** This repo is TypeScript — run `npm ci`
     + `npm run compile` / `npm run build` as the sanity pass. **CI (GitHub Actions) is
     the test gate**; it runs the integration/eval suite.
   - Still run **`/security-review` + `/code-review` (low)** before pushing.
3. Push, open the PR against `<base>`, and **drive CI green** from the logs (github-ops →
   *Read a failing check's log*; the **8-attempt** cap applies).
4. **Mark the issue complete, then stop at the CI-green PR.** Once CI is green,
   run build-playbook **step 8** on the triggering issue — remove `ready-for-ai`, add
   `generated-by-ai`, comment the PR link. Removing `ready-for-ai` is what stops this
   routine re-firing on the same issue. Then **stop**: do **not** enter a review phase and
   do **not** merge — review-response is [`rework-loop`](../rework-loop/SKILL.md)'s job (it
   fires on the PR-review event), and merging is `merge-flow`'s.

**Not used in cloud mode:** the cap-3 queue, worktrees, and the review-response phase. The
**capture hooks** (SubagentStop/SessionEnd → `proto-learning` issues) *are* delivered to
cloud sessions by the [`cloud-skill-sync`](../../../../scripts/cloud-skill-sync/) setup
script, so self-learning capture runs in cloud too — degrading gracefully (log-and-skip) if
`jq`/`claude`/`gh` aren't present in the environment. The same guardrails still hold —
`ready-for-ai` is the only gate, reviews are non-negotiable, follow the repo's `CLAUDE.md`,
never leave CI red, and a blocked issue gets a comment + stop.
