---
name: loop-dispatch
description: >-
  Single front door for a repo's automation loops, so one routine per repo can
  handle every loop event instead of one routine per event. Deterministically
  routes each triggering GitHub event (parsed from the trigger block, decided by
  route-event.sh) to the matching loop skill; a non-matching event is a quiet
  no-op. It only routes; each loop owns its own guardrails. Repo-agnostic;
  github-ops required. Trigger from one per-repo routine wired to all the loop
  events.
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
immediately, waking no loop.

## Config (resolve once)

- **Repo** — identify the current repo (github-ops → *Detect base branch / repo*).
- **github-ops required** — every downstream loop uses it; it must be installed.
- **Run context** — cloud routine (the default use) or a local manual run.

## Step 1 — work out what fired (deterministically)

The routing **decision is scripted**, not judged — so it's byte-identical every fire.
Your only job is to lift the fields out of the **`<github-trigger-context>` block** and
run the bundled router.

1. From the trigger block, read `event`, `action`, `owner`, `repo`, `number`, and
   `label`/`state` **verbatim** (see [`references/webhook-context.md`](references/webhook-context.md)).
   **No trigger block present** (cron / manual / no subscription) → **quiet no-op**. Don't
   go looking for work — with no event there's nothing to route, and guessing is exactly
   what we don't want.
2. Run the bundled **`route-event.sh`** (in this skill's directory) with those fields and
   obey its one-line output — do not re-derive the decision yourself:

   ```bash
   bash route-event.sh --event <event> --action <action> --label <label> \
     --state <state> --number <number> --repo <owner/repo>
   # → route=<loop|none> repo=<owner/repo> number=<n>
   ```

   `route=none` → **quiet no-op** (not ours; do not sweep, do not wake a loop to look).
   Otherwise route names the loop to run for `number` (Step 2). The script is a pure
   function of the tuple — an unmatched label like `dependencies` deterministically
   returns `none`, which is what kills the wasteful fires.
3. **Re-check the entity before acting.** Between the event firing and this session
   starting a label can be removed or the PR/issue closed. Fetch it (github-ops →
   `issue_read`/`pull_request_read`, `method: "get"`, exact `owner`/`repo`/`number`) and
   confirm it still carries the triggering label / is still open. If not, **quiet no-op**.

## Step 2 — route (the normal path)

Invoke the matched skill exactly as its own dedicated routine would, scoped to the
specific issue/PR, and **follow that skill's instructions verbatim**:

- `ready-for-ai` issue → **`/mcp-issue-loop`** in **cloud mode** for that issue (local
  run → its local mode). **On a non-MCP repo** (the ops repo, `Umbraco-MCP-Base`, docs)
  use **`/content-issue-loop`** instead — same `route=mcp-issue-loop` signal, but that
  repo has no MCP toolchain to build against.
- `auto-merge` PR → **`/merge-flow`** (it sweeps all `auto-merge` PRs; the event is
  just the wake-up).
- PR review changes-requested → **`/rework-loop`** for that PR.
- `auto-release` issue → **`/auto-release-loop`**, version taken from the issue title.

**One event → one loop.** Do not chain (don't build *then* merge *then* release in a
single fire) — each of those has its own event that will dispatch its own run. Hand
off and stop.

There is deliberately **no sweep / "check everything" fallback** — routing is only ever
driven by a real event through `route-event.sh`. No event, or an unmatched one, is a
quiet no-op. (Working a whole backlog is a separate, explicit action: run the relevant
loop skill directly.)

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

## Wiring it

To stand up the one routine per repo, use the
[`new-loop-routine`](../new-loop-routine/SKILL.md) skill — it owns the standardised
config, the locked prompt template, and the event-wiring steps.
