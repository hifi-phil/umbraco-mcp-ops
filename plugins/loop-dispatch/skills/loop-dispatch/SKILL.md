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

The **front door** to a repo's automation loops. A committed GitHub Action routes each
loop event at the edge (via `route-event.sh`) and fires this routine **only on a match**,
handing it the resolved route. This skill **dispatches that route** to the matching loop —
one routine per repo instead of one per loop/event.

It is a **router, not a worker.** It never builds, merges, or releases anything
itself; it invokes the loop skill that owns that job, and that skill enforces all its
own gates, models, and notifications. loop-dispatch adds no policy of its own.

## The routing table

`route-event.sh` (run **at the edge** by the caller workflow — see new-loop-routine and
[`references/webhook-context.md`](references/webhook-context.md), not here) maps the exact
`(event, action, label|state)` tuple to a loop. Anything unmatched → the routine is
**never fired**. The mapping it applies:

| event | action | label / state | Run |
|---|---|---|---|
| `issues` | `labeled` | label = `ready-for-ai` | **`/mcp-issue-loop`** (cloud mode) |
| `issues` | `labeled` | label = `auto-release` (issue title `release <version>`) | **`/auto-release-loop`** |
| `pull_request` | `labeled` | label = `auto-merge` | **`/merge-flow`** |
| `pull_request` | `labeled` | label = `auto-rework` | **`/rework-loop`** |

Rework is a **label**, not the review event — uniform with the rest, and it works with one
account (you can't fire a `pull_request_review` workflow by reviewing your *own* PR, and
the loop's identity is often the reviewer's). Flow: a reviewer leaves comments, then adds
`auto-rework` to say "address these". Review events route nowhere.

Everything else — `pull_request.opened`, a PR labelled `dependencies`/`javascript`, an
issue labelled anything else, any review event — matches **no row**, so the edge never
fires the routine. This is what kills the wasteful fires: a Dependabot PR labelled
`dependencies` woke merge-flow **4× overnight** under per-event routines; here the edge
stops immediately, waking no routine.

## Config (resolve once)

- **Repo** — identify the current repo (github-ops → *Detect base branch / repo*).
- **github-ops required** — every downstream loop uses it; it must be installed.

## Step 1 — take the resolved route

Your turn contains the decision the **edge already made** — e.g.
`route=merge-flow repo=umbraco/… number=269`. The caller workflow ran `route-event.sh`
and only fired you because it matched, so **take that route as given; don't re-derive it.**
(If a fire ever arrives with no resolved route, **quiet no-op** — never go looking for work.)

**Re-check the entity before acting.** Between the event and this session a label can be
removed or the PR/issue closed. Fetch it (github-ops → `issue_read`/`pull_request_read`,
`method: "get"`, exact `owner`/`repo`/`number`) and confirm it still carries the
triggering label / is still open. If not, **quiet no-op**.

## Step 2 — dispatch the route

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
