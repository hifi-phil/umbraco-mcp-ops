---
name: issue-build-loop
description: >-
  Work the open GitHub issues labelled `ready-for-ai` in any repo, driving each to a
  CI-green, mcp-reviewed PR — then hand off (human change-requests → rework-loop, merge
  → merge-flow). This loop never responds to human reviews and never merges. Repo-agnostic
  across both Umbraco MCP repos (full build/test toolchain) and repos with no toolchain
  (the umbraco-mcp-ops repo, docs repos, plugin repos) — it detects the repo's shape and
  uses the matching build playbook; github-ops required. Trigger on "work the ready
  issues", "run the issue loop", "work the ready ops issues", "run the content loop",
  "action the loop-improvement issues", "convert the loop-improvement backlog", or a
  routine on Issue: Labeled `ready-for-ai` (cloud).
---

# issue-build-loop

A durable loop that turns the `ready-for-ai` GitHub backlog into CI-green, reviewed,
handed-off PRs — on **any** repo, whether or not it has an Umbraco build/test toolchain.
Only the per-issue build playbook differs between the two shapes; everything else
(gathering the backlog, dispatch, CI-driving, review, hand-off, stop conditions) is
identical, so it's covered once, below.

**Two independent things are set up front:**
- **Repo shape** — resolved in [Config](#config-resolve-once-up-front): MCP repo (has
  the toolchain) vs content repo (doesn't). Decides which build playbook a build subagent
  gets — [`references/issue-lifecycle.md`](references/issue-lifecycle.md) or
  [`references/content-playbook.md`](references/content-playbook.md).
- **Run mode**, set by the caller (default **local**; a routine states **cloud mode**
  explicitly):
  - **Local (orchestrated)** — a long-lived loop over the whole backlog: one worktree +
    build subagent per issue (cap 3; hook-backed for MCP repos), capture hooks running.
    Everything from *Config* through *Rules* below.
  - **Cloud (one-shot per issue)** — a routine fires once per `ready-for-ai` issue
    (cross-issue parallelism comes from separate sessions); no worktree. See
    [Cloud mode](#cloud-mode).

**Both modes end the same way, regardless of shape:** each issue reaches a CI-green,
mcp-reviewed PR, then you stop and hand off (see Step 3 and Step 4) — **this loop never
responds to human reviews and never merges.**

In **local mode** you are the **orchestrator**: a loop (surviving across turns / wake-ups)
whose terminal condition is *every open `ready-for-ai` issue has a CI-green, mcp-reviewed PR
handed off, or is blocked-with-a-comment*. You reach it by dispatching **one build subagent
per issue, each in its own git worktree** (cap **3**), then driving each returned PR's CI
green and reviewing it with `mcp-review`. Each issue's lifecycle is **build → CI-green →
review → hand off** — detail in [`references/issue-lifecycle.md`](references/issue-lifecycle.md)
(build) and Step 3/4 below (the rest).

`/goal` keeps the loop alive across build/CI waits — set it in Step 2, clear it when every
issue is handed off or blocked.

## Config (resolve once, up front)

| Thing | How to resolve | Default |
|-------|----------------|---------|
| Repo | identify the current repo (github-ops → *Detect base branch / repo*) | current repo |
| AI label | fixed | `ready-for-ai` |
| Base branch | detect via the `release-and-branching` skill (gitflow → `dev`) | `dev` |
| Concurrency cap | fixed | **3** |

**Resolve the repo's shape first — don't go by what the repo is "for".** Check for a
`CLAUDE.md` and worktree hooks in `.claude/settings.json`, and match against:

| Shape | Marker | Playbook | Notes |
|---|---|---|---|
| **MCP server repo** — the `@umbraco-cms/mcp-*` family | `src/umbraco-api/tools/` | [`issue-lifecycle.md`](references/issue-lifecycle.md) | The common case. |
| **MCP SDK monorepo** — `umbraco/Umbraco-MCP-Base` | `packages/mcp-server-sdk` | [`issue-lifecycle.md`](references/issue-lifecycle.md) | Also `packages/hosted-mcp`, `packages/create-mcp-server`, `template`, and `plugins/umbraco-mcp-skills`. **Use the MCP playbook even for a skills-only change** — the repo has a real toolchain, so the content playbook doesn't fit. |
| **Content repo** — no Umbraco build/test toolchain | no `src/umbraco-api/tools/`, no `packages/mcp-server-sdk`; e.g. the `umbraco-mcp-ops` repo (skills, plugins, scripts, workflows), docs repos, plugin repos | [`content-playbook.md`](references/content-playbook.md) | Lightweight: no worktree DB hooks, no `npm run test:all`, no MCP skills. This is the converter for the `loop-improvement` issues triage files on the ops repo. |

If a repo matches none of the three (not even a content-shaped git repo), stop and say
so.

**Don't assume the repo's scripts.** The two MCP shapes don't even share script names
with each other: server repos have `npm run test:all` / `test:changed` / `start:umbraco`;
the SDK monorepo has `npm test`, `test:integration`, `test:e2e`, `test:template`,
`test:cli`, and builds with `npm run build` / `build:all`. Content repos may have no test
script at all. **Read `package.json`** (or `CLAUDE.md`) and use what's actually there —
never assume.

**Ops-repo scope guardrail:** on `umbraco-mcp-ops` specifically, triage files
`loop-improvement` issues **without** the `ready-for-ai` label on purpose — a human
decides whether to promote one. Don't self-label those in Step 1.

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
prompt is the **build playbook matching the repo's shape** —
[`references/issue-lifecycle.md`](references/issue-lifecycle.md) for MCP repos,
[`references/content-playbook.md`](references/content-playbook.md) for content
repos — with the issue's number/title/body substituted in. Do **not** pass
`isolation: worktree` on the Agent call — the subagent creates the worktree itself
(via `EnterWorktree`, hook-backed on MCP repos), which the generic isolation would
bypass.

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
suite on MCP repos; whatever check the content playbook ran on content repos), and the
review→fix cycle must re-test locally and only then re-green CI, never leaning on CI to
catch a fix's regressions. Only once `mcp-review` is clean/addressed do the
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

**Content-repo work skews lighter** — `sonnet` by default, `haiku` for pure-docs/typo
fixes, `opus` only for intricate skill/plugin logic. Same floor and rounding rule as above.

**Floor:** never dispatch a code-touching issue below `sonnet`. `haiku` is only
acceptable for genuinely non-code work. When unsure, round **up** a tier — an
over-powered build is cheaper than a blocked one.

**Never use `fable` — for any subagent, any issue, any tier.** It is not a valid
choice in this loop.

(Human-review responses aren't modelled here — they're `rework-loop`'s, which picks its own
model.)

The tier names resolve to the current model in each family, so the skill doesn't
go stale as versions advance.

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

## Rules

- **Never touch an issue without the `ready-for-ai` label.** The label is the
  only gate. If a human removes it mid-flight, stop work on that issue. The one
  exception is the **outcome swap**: the loop itself removes `ready-for-ai` and adds
  `generated-by-ai` (green PR) or `ai-blocked` (backstop tripped) — this is now the
  orchestrator's own step (see [Step 3](#step-3--build-ci-and-review-rolling-cap-3) above), not
  the build subagent's — and it's the loop finishing the issue, not a human pulling the
  gate.
- **One worktree per issue, via `EnterWorktree`.** On MCP repos this is hook-backed (see
  `references/issue-lifecycle.md`'s worktree step for what the hook does); on content
  repos it's a plain worktree (no DB/env/port hooks to fire) — see
  `references/content-playbook.md`. Never hand-roll `git worktree add` and never use the
  Agent tool's generic `isolation: worktree`.
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

## Cloud mode

Everything above (Config → Rules) is **local mode**. Cloud mode is a full,
one-shot-per-issue playbook (cross-issue parallelism comes from separate sessions
firing, not a queue), set explicitly by the caller — see
[`references/cloud-mode.md`](references/cloud-mode.md).
