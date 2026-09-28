---
name: merge-flow
description: >-
  Guardrail loop for merging pull requests safely. Finds open PRs labelled
  `auto-merge` and merges each only once every safety gate holds; on any unmet gate it
  comments the blocker and moves on rather than merging. Replaces error-prone manual
  merges. Repo-agnostic; runs locally or as a scheduled cloud routine; requires the
  `github-ops` skill. Trigger on "merge the ready PRs", "run merge-flow", "auto-merge
  the queue".
---

# merge-flow

A guardrail loop that removes the manual PR merge — the step where mistakes happen
(merging red CI, merging before approval, merging into the wrong base, forgetting
to delete the branch). You label a PR `auto-merge`; this loop merges it **only when
every gate holds**, and never otherwise.

`/goal` makes "done" unambiguous: the loop keeps working until every `auto-merge`
PR is either **merged** (branch deleted where the environment can — see Step 3) or
**flagged with the reason it couldn't be**. No half-done merges.

## Runtime & auth

For every GitHub action — listing PRs, reading reviews, checking CI, merging,
deleting the branch — **use the `github-ops` skill**, which owns the local-vs-web
mechanism (this skill names the operation; `github-ops` has the command/tool).
Scheduled-routine wiring is set up separately (see
[Running as a routine](#running-as-a-routine)).

## Config

| Thing | Value |
|-------|-------|
| Trigger label | **`auto-merge`** |
| Target repos | any repo you point it at (the Umbraco MCP repos, `umbraco-mcp-ops`, `Umbraco-MCP-Base`, …) |
| Merge strategy | per repo convention — **detect via `release-and-branching`** (gitflow usually squash-into-`dev`; main-only per that repo) |
| PRs per run cap | **10** |

## Step 1 — find candidates

**List open PRs** filtered by the `auto-merge` label (github-ops → *List PRs by
label / state*). No candidates → report "nothing to merge" and stop. More candidates
than the **PRs per run cap** (see Config) → process only that many this run; the rest
wait for the next run.

## Step 2 — verify EVERY gate (this is the whole point)

For each candidate, all must hold — if any fails, **do not merge** (go to Step 4):

1. **Human approval = the `auto-merge` label.** The merge stays human-gated: a
   maintainer must deliberately apply the `auto-merge` label after reviewing the PR,
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
   cap (e.g. 15 min); if still pending, treat as not-yet-mergeable and leave it for the
   next run.
3. **Mergeable / no conflicts.** The PR must report mergeable with no conflicts (get
   it via github-ops → *Get a PR*). If it's behind its base, update the branch first,
   then re-check CI (that restarts checks).
4. **Right base.** The PR targets the expected integration branch for its repo's merge
   strategy (see Config). A PR into `main` on a gitflow repo is a **release** merge —
   that's `auto-release-loop`'s job, not this one; skip it here.

## Step 3 — merge

**Merge the PR** (github-ops → *Merge a PR*) using the repo's convention (see Config).
**Never force a merge past a failing gate.** Comment confirming the merge. If the merge
itself fails, report it — never retry with a force.

**Then delete the head branch, best-effort.** Locally `gh` does it as part of the merge.
**In a cloud routine it cannot be done** — the GitHub MCP server has no branch-delete
tool (see the `github-mcp.md` Notes), so don't treat a surviving branch as a failed
merge, and don't go hunting for a tool that does it. Two things clean up after you: the
repo's **"Automatically delete head branches"** setting reaps it at merge time (on for all
three MCP repos), and failing that the weekly local `branch-housekeeping` run reaps it and
flags any repo where the setting is off.

## Step 4 — when a gate fails

Comment the **specific** blocker on the PR ("CI check `x` failing", "awaiting
approval", "conflicts with base — rebase needed"), and log it as deferred. By default
**leave the `auto-merge` label on** so the next run re-checks once the blocker clears.
Remove the label only for a hard, human-needed block (unresolvable conflicts, changes
requested) so the loop stops re-poking it — say which in the comment.

## Running as a routine

**Primary: event-triggered.** Set up a routine with trigger **PR: Labeled**, filtered to
**Labels is one of `auto-merge`**, so labelling a PR fires this **immediately** — it
gate-checks the current `auto-merge` PR(s) and merges the eligible ones. This is the
cheapest shape (it only fires when you label — no idle runs) and the most responsive.
The skill queries for all `auto-merge` PRs, so a single-PR event just runs one pass of
the same loop; nothing changes for one-at-a-time.

**Optional backstop:** a low-frequency poll (e.g. once or twice a weekday) catches a PR
whose CI went green *after* its event run's CI-wait timed out. Not needed if you label
after CI is green.
