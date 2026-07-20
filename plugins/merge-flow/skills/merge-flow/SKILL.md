---
name: merge-flow
description: >-
  Guardrail loop for merging pull requests safely. Finds open PRs labelled
  `auto-merge` — the maintainer's deliberate go-signal, which stands in for a review
  approval (GitHub forbids approving your own PR, and loop-authored PRs are often
  yours) — and merges each only after verifying every remaining gate: CI actually
  green (polled, never trusting `--auto`), no conflicts, the expected base branch, and
  no unresolved "changes requested". On any unmet gate it comments the blocker and
  moves on rather than merging. Replaces error-prone manual merges. Repo-agnostic;
  runs locally or as a scheduled cloud routine; GitHub work goes through the required
  `github-ops` skill. Uses `/goal` so a merge job is provably finished. Trigger on
  "merge the ready PRs", "run merge-flow", "auto-merge the queue".
---

# merge-flow

A guardrail loop that removes the manual PR merge — the step where mistakes happen
(merging red CI, merging before approval, merging into the wrong base, forgetting
to delete the branch). You label a PR `auto-merge`; this loop merges it **only when
every gate holds**, and never otherwise.

`/goal` makes "done" unambiguous: the loop keeps working until every `auto-merge`
PR is either **merged with its branch deleted** or **flagged with the reason it
couldn't be**. No half-done merges.

## Runtime & auth

For every GitHub action — listing PRs, reading reviews, checking CI, merging,
deleting the branch — **use the `github-ops` skill**, which owns the local-vs-web
mechanism (this skill names the operation; `github-ops` has the command/tool).
Scheduled-routine wiring is set up separately (see
[Running as a routine](#running-as-a-scheduled-routine)).

> **`github-ops` must be installed for this loop to run.**

## Config

| Thing | Value |
|-------|-------|
| Trigger label | **`auto-merge`** |
| Target repos | any repo you point it at (the Umbraco MCP repos, `umbraco-mcp-ops`, `Umbraco-MCP-Base`, …) |
| Merge strategy | per repo convention — **detect via `release-and-branching`** |
| PRs per run cap | **10** |

## Step 1 — find candidates

**List open PRs** filtered by the `auto-merge` label (github-ops → *List PRs by
label / state*). No candidates → report "nothing to merge" and stop.

## Step 2 — verify EVERY gate (this is the whole point)

For each candidate, all must hold — if any fails, **do not merge** (go to Step 4):

1. **Human approval = the `auto-merge` label.** The merge stays human-gated: a
   maintainer must deliberately apply the `auto-merge` label after reviewing the PR,
   and that label is the human approval signal this loop requires. (A GitHub review
   "approve" is not used as the signal, because a maintainer cannot approve a PR they
   authored — and these PRs are commonly authored by the maintainer or the loop.) The
   label being present (Step 1) satisfies this gate. As an added safeguard, check
   reviews (github-ops → *Get a PR*): an unresolved **"changes requested"** is a human
   veto — do not merge despite the label.
2. **CI genuinely green.** Poll the PR's check-run status (github-ops → *Get PR CI /
   check-run status*) until nothing is pending, then require **every** check to pass.
   **Never rely on an auto-merge that bypasses this gate** — this org has no branch
   protection, so an auto-merge would land without a real green gate (see the
   wait-for-CI rule). Wait up to a sane cap (e.g. 15 min); if still pending, treat as
   not-yet-mergeable and leave it for the next run.
3. **Mergeable / no conflicts.** The PR must report mergeable with no conflicts (get
   it via github-ops → *Get a PR*). If it's behind its base, update the branch first,
   then re-check CI (that restarts checks).
4. **Right base.** The PR targets the expected integration branch (gitflow → `dev`;
   main-only → `main`). A PR into `main` on a gitflow repo is a **release** merge —
   that's `auto-release-loop`'s job, not this one; skip it here.

## Step 3 — merge

**Merge the PR and delete its branch** (github-ops → *Merge a PR (+ delete branch)*)
using the repo's convention — detect it via `release-and-branching` (gitflow usually
squash-into-`dev`; main-only per that repo). Comment confirming the merge. If the
merge itself fails, report it — never retry a force.

## Step 4 — when a gate fails

Comment the **specific** blocker on the PR ("CI check `x` failing", "awaiting
approval", "conflicts with base — rebase needed"). By default **leave the
`auto-merge` label on** so the next run re-checks once the blocker clears. Remove
the label only for a hard, human-needed block (unresolvable conflicts, changes
requested) so the loop stops re-poking it — say which in the comment.

## Guardrails

- **Never merge without the `auto-merge` label + green + mergeable + correct base.**
  No exceptions — the label is the required human approval; the other three are
  machine-verified.
- **An unresolved "changes requested" review vetoes the merge** even with the label —
  a human "no" outranks it.
- **Never `--auto`, never force-merge, never merge a PR into `main` on a gitflow repo**
  (that's a release).
- **≤ 10 merges per run**; log any deferred.
- The `auto-merge` label must be applied **deliberately by a maintainer after review** —
  that act is the human gate, so control who can apply it.

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

All GitHub work goes through the `github-ops` skill. *(Routine wiring is done separately.)*
