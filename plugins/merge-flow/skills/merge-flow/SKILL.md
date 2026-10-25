---
name: merge-flow
description: >-
  Guardrail loop for merging one pull request safely. Takes the PR its fire names
  (labelled `auto-merging`) and merges it only once every safety gate holds; on any unmet
  gate it comments the blocker and stops rather than merging. Replaces error-prone manual
  merges. Repo-agnostic; fired by the Worker through `loop-dispatch`; requires the
  `github-ops` and `agent-outcomes` skills. Trigger: a PR labelled `auto-merging`.
---

# merge-flow

A guardrail loop that removes the manual PR merge — the step where mistakes happen
(merging red CI, merging before approval, merging into the wrong base, forgetting
to delete the branch). You label a PR `auto-merging`; this loop merges it **only when
every gate holds**, and never otherwise.

One fire is one PR: the one the fire names, and only that one. `/goal` makes "done"
unambiguous: the loop keeps working until that PR is either **merged** (branch deleted
where the environment can — see Step 3) or **flagged with the reason it couldn't be**.
No half-done merges.

## Runtime & auth

For every GitHub action — listing PRs, reading reviews, checking CI, merging,
deleting the branch — **use the `github-ops` skill**, which owns the local-vs-web
mechanism (this skill names the operation; `github-ops` has the command/tool).
Scheduled-routine wiring is set up separately (see
[Running as a routine](#running-as-a-routine)).

## Config

| Thing | Value |
|-------|-------|
| Trigger label | **`auto-merging`** |
| Target repos | any repo you point it at (the Umbraco MCP repos, `umbraco-mcp-ops`, `Umbraco-MCP-Base`, …) |
| Merge strategy | per repo convention — **detect via `release-and-branching`** (gitflow usually squash-into-`dev`; main-only per that repo) |

## Step 1 — take the PR the fire names

**Get that PR** (github-ops → *Get a PR*) by the number in the fire. Don't list or look
at any other `auto-merging` PR. If it is no longer open or no longer carries
`auto-merging`, report "nothing to merge" and stop.

## Step 2 — verify EVERY gate (this is the whole point)

All of these must hold for the PR — if any fails, **do not merge** (go to Step 4):

1. **Human approval = the `auto-merging` label.** The merge stays human-gated: a
   maintainer must deliberately apply the `auto-merging` label after reviewing the PR,
   and that label is the human approval signal this loop requires — control who can
   apply it. (A GitHub review
   "approve" is not used as the signal, because a maintainer cannot approve a PR they
   authored — and these PRs are commonly authored by the maintainer or the loop.) The
   label being present (Step 1) satisfies this gate. As an added safeguard, check
   reviews (github-ops → *Get a PR*): an unresolved **"changes requested"** is a human
   veto — do not merge despite the label.
2. **CI genuinely green.** Poll the PR's check-run status (github-ops → *Get PR CI /
   check-run status*) until nothing is pending, then require **every** check to pass.
   **Never rely on an auto-merge that bypasses this gate** — this org has no branch
   protection, so an auto-merge would land without a real green gate. Wait up to a sane
   cap (e.g. 15 min); if still pending, treat as not-yet-mergeable, **comment on the PR**
   that CI was still pending at the cap, and treat it as a failed gate (Step 4).
3. **Mergeable / no conflicts.** The PR must report mergeable with no conflicts (get
   it via github-ops → *Get a PR*). If it's behind its base, update the branch first,
   then re-check CI (that restarts checks).
4. **Right base.** The PR targets the expected integration branch for its repo's merge
   strategy (see Config). A PR into `main` on a gitflow repo is a **release** merge —
   the Worker makes it after `release_approved`, not this loop; skip it here.

## Step 3 — merge

**Merge the PR** (github-ops → *Merge a PR*) using the repo's convention (see Config).
**Never force a merge past a failing gate.** Post one short summary comment on the PR: what
was merged, the merge commit, and which gates were checked. **No `agent-outcome` marker**: the `agent-outcomes` skill's
catalog has no merge outcome, because the Worker sees the merge as a native GitHub event.
If the merge
itself fails, report it — never retry with a force.

**Then delete the head branch, best-effort.**
**In a cloud routine it cannot be done** — the GitHub MCP server has no branch-delete
tool (see the `github-mcp.md` Notes), so don't treat a surviving branch as a failed
merge, and don't go hunting for a tool that does it. Two things clean up after you: the
repo's **"Automatically delete head branches"** setting reaps it at merge time (on for all
three MCP repos), and failing that the weekly local `branch-housekeeping` run reaps it and
flags any repo where the setting is off.

## Step 4 — when a gate fails

Comment the **specific** blocker on the PR ("CI check `x` failing", "awaiting
approval", "conflicts with base — rebase needed"), and stop. For a hard,
human-needed block the orchestrator's gate missed (say a conflict appeared with no CI run
since), report `merge_blocked` through the `agent-outcomes` script and put the body it printed in that comment, with the reason.
The orchestrator checks for conflicts and requested changes itself, and sends failing CI to
`rework-loop`, so on red CI comment the failing checks and stop.

## Running as a routine

The Worker fires this through `loop-dispatch` (route `merge-flow`) when the PR is labelled
`auto-merging` and its gate passes, on an environment that has this skill (+ `github-ops`,
`agent-outcomes`).
