---
name: mcp-issue-loop
description: >-
  Work through the open GitHub issues labelled `ready-for-ai` in an Umbraco MCP
  repo, one git worktree + subagent per issue (max 3 in parallel), driving each
  to completion. Each issue is implemented following established MCP patterns and
  skills, security-reviewed and code-reviewed, pushed, its CI driven green, and a
  PR opened — then the loop monitors that PR for the human's review and responds
  to review feedback, iterating until the PR is approved and merged. Repo-agnostic
  across Umbraco MCP repos; runs locally or as a scheduled cloud routine. Trigger
  on "work the ready issues", "action the ready-for-ai issues", "complete the AI
  issues", "run the issue loop", "pick up the AI-ready backlog".
---

# mcp-issue-loop

A durable loop that turns the `ready-for-ai` GitHub backlog into merged PRs.

You are the **orchestrator**. You own a long-lived loop (it survives across turns
and scheduled wake-ups) whose terminal condition is: *every open `ready-for-ai`
issue in this repo has a PR that CI passed, that the human reviewed, and that is
approved + merged.* You reach that state by dispatching **one subagent per issue,
each in its own git worktree**, capped at **3 running at once**.

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
| Repo | `gh repo view --json nameWithOwner -q .nameWithOwner` | current repo |
| AI label | fixed | `ready-for-ai` |
| Base branch | detect via the `release-and-branching` skill (gitflow → `dev`) | `dev` |
| Concurrency cap | fixed | **3** |

This skill assumes an **Umbraco MCP repo** — the `@umbraco-cms/mcp-*` server
family. Confirm the repo looks like one (has `src/umbraco-api/tools/`, a
`CLAUDE.md`, worktree hooks in `.claude/settings.json`). If it doesn't, stop and
say so — the build playbook's MCP/test conventions won't apply.

## Step 1 — gather the backlog

```bash
gh issue list --repo <repo> --label ready-for-ai --state open \
  --json number,title,body,labels --limit 100
```

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

**Watch for reviews.** Poll the open PRs for new review activity. Prefer a single
poller over per-PR monitors:

```bash
# one line per PR whose review state or head has changed since last poll
for pr in <prNumbers>; do
  gh pr view "$pr" --repo <repo> \
    --json number,reviewDecision,reviews,mergeStateStatus,statusCheckRollup
done
```

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

The loop feeds its own improvement. As work happens, it emits **proto-learnings**
— raw observations that *something is worth improving somewhere*. This skill only
**captures** them; a separate scheduled routine (Loop B) triages them into PRs.
Never fix skills or `CLAUDE.md` inline from here.

- **Subagents** file proto-learnings as their final step — see the build and
  review-response playbooks and the [schema](references/proto-learning-schema.md).
- **You (orchestrator)** file proto-learnings for **loop-level** observations that
  no single subagent can see: a backstop that tripped, a class of issue that
  consistently needed `opus`, review-round churn, a recurring blocker. Do this at
  hand-back (`phase: "orchestrator"`).
- Proto-learnings are **GitHub issues labelled `proto-learning` on
  `hifi-phil/umbraco-mcp-ops`** (the plugin is read-only and may run on a
  stateless runner, so it can't store them itself).
- **Signal, not noise:** file one only when something non-obvious happened; file
  nothing for a clean run. One proto-learning per distinct lesson.

## Rules

- **Never touch an issue without the `ready-for-ai` label.** The label is the
  only gate. If a human removes it mid-flight, stop work on that issue.
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

## Running on a cloud instance (later)

The design is already cloud-shaped: Step 1–3 are a burst of parallel work; Step 4
is a scheduled poll-and-react. To run unattended as a routine, the same skill
runs headless — `/goal` plus `ScheduleWakeup` become the routine's persistence,
and the review-response dispatch fires whenever a wake-up finds
`CHANGES_REQUESTED`. Nothing in the loop assumes an interactive human is present
except the review itself, which is exactly the intended human gate.
