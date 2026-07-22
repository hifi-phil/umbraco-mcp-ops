---
name: loop-dispatch
description: >-
  Single front door for a repo's automation loops, so one routine per repo can
  handle every loop event instead of one routine per event. Given the triggering
  GitHub event it routes to the matching loop skill — `ready-for-ai` issue →
  mcp-issue-loop (cloud), `auto-merge` PR → merge-flow, PR review (changes
  requested) → rework-loop, `auto-release` issue → auto-release-loop — and falls
  back to a full sweep of all four when the event context isn't available. It only
  routes; each loop owns its own guardrails. Repo-agnostic; github-ops required.
  Trigger from one per-repo routine wired to all the loop events, or run manually
  as "dispatch the loops for this repo".
---

# loop-dispatch

The **front door** to a repo's automation loops. Instead of **four event-triggered
routines per repo** (mcp-issue-loop, merge-flow, rework-loop, auto-release-loop),
wire **one routine per repo** to all the loop events and point it here — this skill
works out what fired and runs the matching loop.

It is a **router, not a worker.** It never builds, merges, or releases anything
itself; it invokes the loop skill that owns that job, and that skill enforces all its
own gates, models, and notifications. loop-dispatch adds no policy of its own.

## The routing table

Match the **exact `(event, action, label|state)` tuple** from the trigger block. If none
match — including a label event whose label is *not* one of ours — **quiet no-op**.
Never wake a loop just to "have a look".

| event | action | label / state | Run |
|---|---|---|---|
| `issues` | `labeled` | label = `ready-for-ai` | **`/mcp-issue-loop`** (cloud mode) |
| `issues` | `labeled` | label = `auto-release` (issue title `release <version>`) | **`/auto-release-loop`** |
| `pull_request` | `labeled` | label = `auto-merge` | **`/merge-flow`** |
| `pull_request_review` | `submitted` | state = `changes_requested` | **`/rework-loop`** |

Everything else — `pull_request.opened`, a PR labelled `dependencies`/`javascript`, an
issue labelled anything else, an approving review — matches **no row → quiet no-op**.
This is what kills the wasteful fires: a Dependabot PR labelled `dependencies` woke
merge-flow **4× overnight** under per-event routines; here it matches no row and stops
before any sweep.

## Config (resolve once)

- **Repo** — identify the current repo (github-ops → *Detect base branch / repo*).
- **github-ops required** — every downstream loop uses it; it must be installed.
- **Run context** — cloud routine (the default use) or a local manual run.

## Step 1 — work out what fired (deterministically)

Read the event from the **`<github-trigger-context>` block** in your opening context and
parse it exactly as [`references/webhook-context.md`](references/webhook-context.md)
describes — extract `event`, `action`, `owner`, `repo`, `number`, and `label`/`state`
**verbatim, no inference**.

- **Trigger block present →** match the `(event, action, label|state)` tuple against the
  [routing table](#the-routing-table). **Match exactly one row, or none.** A non-match
  (e.g. a PR labelled `dependencies`) is a **quiet no-op** — do **not** fall through to a
  sweep, and do **not** wake a loop to check. This exact gate is the point of the router.
- **Trigger block absent** (cron / manual run / no subscription) → go to
  [Sweep](#step-2b--sweep-no-event-context). Sweep is only ever for the no-event case.
- **Re-check the entity before acting.** Between the event firing and this session
  starting, a label can be removed or the PR/issue closed. Fetch it (github-ops →
  `issue_read`/`pull_request_read`, `method: "get"`, using the exact `owner`/`repo`/
  `number`) and confirm it still carries the triggering label / is still open. If not,
  **quiet no-op** — the world moved on.

## Step 2 — route (the normal path)

Invoke the matched skill exactly as its own dedicated routine would, scoped to the
specific issue/PR, and **follow that skill's instructions verbatim**:

- `ready-for-ai` issue → **`/mcp-issue-loop`**, told to run in **cloud mode** for that
  issue (in a local run, use its local mode instead).
- `auto-merge` PR → **`/merge-flow`** (it sweeps all `auto-merge` PRs; the event is
  just the wake-up).
- PR review changes-requested → **`/rework-loop`** for that PR.
- `auto-release` issue → **`/auto-release-loop`**, version taken from the issue title.

**One event → one loop.** Do not chain (don't build *then* merge *then* release in a
single fire) — each of those has its own event that will dispatch its own run. Hand
off and stop.

## Step 2b — sweep (no event context)

When the fire carries no usable event detail, check each loop's precondition in this
order and run the ones with actionable work (each is a quiet no-op when there's
nothing):

1. **rework-loop** — any bot-authored PR with an unresolved changes-requested review?
   (unblock in-flight work first)
2. **merge-flow** — any `auto-merge` PR that's green + clean? (land what's ready)
3. **mcp-issue-loop** (cloud) — any open `ready-for-ai` issue? (start new work)
4. **auto-release-loop** — any open `auto-release` issue? (ship)

Use github-ops list queries (→ *List issues by label / state*, *List PRs by label /
state*, *Get PR reviews*) to test each precondition cheaply before invoking a loop.
Sweep does more work per fire than routing, so **prefer a routed fire**; sweep is the
safety net (and the natural shape for a scheduled/manual "run the loops for this repo"
invocation).

## Rules

- **Route, never reimplement.** loop-dispatch only invokes the loop skills. All
  merge/build/release/review policy, models, caps, and notifications live in those
  skills — defer to them completely.
- **Re-check preconditions.** Never act on a stale event; if the label's gone or the
  PR/issue is closed, quiet no-op.
- **One event, one loop.** No chaining within a single fire.
- **Respect each loop's gate** — `ready-for-ai` for building, `auto-merge` as the
  merge approval, `auto-release` to ship. loop-dispatch does not relax any of them.
- **Quiet by default.** Say nothing unless a delegated loop does — don't add a
  dispatch-level notification on top of the loop's own.
- **github-ops for all GitHub work.** Name the operation; it owns the command/tool.
- **Never use `fable`.** The dispatcher runs on a cheap base model (inherit the
  routine's model); the real work — and its model choice — happens inside the loop
  skills and their subagents.

## Wiring it (one routine per repo)

Create **one** routine per repo whose prompt is essentially *"Run `/loop-dispatch` for
`<owner/repo>`"*, and attach every loop event you want it to handle (Issue: Labeled
`ready-for-ai`, PR: Labeled `auto-merge`, PR review, Issue: Labeled `auto-release`).
That one routine replaces the four per-repo routines. The loop skills must be present
in the environment (delivered by the `cloud-skill-sync` setup script — add
`loop-dispatch` to its `SKILLS` list alongside the loops it routes to).

> **Requires** that a routine can carry multiple event triggers and that the fired
> session can see which event fired. If your routine platform allows only one trigger
> per routine, keep separate routines (or run loop-dispatch in **sweep** mode on a
> single broad trigger / schedule). If the platform can't pass event context at all,
> loop-dispatch still works via sweep — it just checks all four preconditions each fire.
