---
name: merge-flow
description: >-
  Guardrail loop for merging pull requests safely. Finds open PRs labelled
  `auto-merge` and merges each — but only after verifying every gate: an approving
  review with no unresolved change-requests, CI actually green (polled, never
  trusting `--auto`), no conflicts, and the expected base branch. On any unmet
  gate it comments the blocker and moves on rather than merging. Replaces
  error-prone manual merges. Repo-agnostic; runs locally (`gh`) or as a scheduled
  cloud routine (REST). Uses `/goal` so a merge job is provably finished. Trigger
  on "merge the ready PRs", "run merge-flow", "auto-merge approved PRs", "merge the
  auto-merge queue".
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

Same as the other ops loops:

- **Local:** `gh` works; uses your login.
- **Scheduled cloud routine:** GitHub **REST** (not `gh`), proxy-injected
  `GH_TOKEN`. Needs **`pull_requests: write` + `contents: write`** on the target
  repos (see the shared GitHub-App-permissions note in `triage-learnings`).
- The scheduled-routine wiring is set up separately (see [Running as a routine](#running-as-a-scheduled-routine)).

## Config

| Thing | Value |
|-------|-------|
| Trigger label | **`auto-merge`** |
| Target repos | any repo you point it at (the Umbraco MCP repos, `umbraco-mcp-ops`, `Umbraco-MCP-Base`, …) |
| Merge strategy | per repo convention — **detect via `release-and-branching`** |
| PRs per run cap | **10** |

## Step 1 — find candidates

```
gh pr list --repo <repo> --label auto-merge --state open --json number,title,baseRefName
```
(REST equivalent on a runner: `GET /repos/{repo}/pulls?state=open` then filter by
label.) No candidates → report "nothing to merge" and stop.

## Step 2 — verify EVERY gate (this is the whole point)

For each candidate, all must hold — if any fails, **do not merge** (go to Step 4):

1. **Approved.** `reviewDecision == APPROVED`. No `CHANGES_REQUESTED` and no
   unresolved review threads. A bare comment is not approval.
2. **CI genuinely green.** Poll `gh pr checks <n>` until no check is pending, then
   require **every** check `pass`. **Never use `gh pr merge --auto`** — this org has
   no branch protection, so `--auto` would merge without a real green gate (see the
   wait-for-CI rule). Wait up to a sane cap (e.g. 15 min); if still pending, treat
   as not-yet-mergeable and leave it for the next run.
3. **Mergeable / no conflicts.** `mergeable == MERGEABLE` and `mergeStateStatus` is
   not `DIRTY`/`BLOCKED`. If `BEHIND`, update the branch from base first, then
   re-check CI (a rebase/merge restarts checks).
4. **Right base.** The PR targets the expected integration branch (gitflow → `dev`;
   main-only → `main`). A PR into `main` on a gitflow repo is a **release** merge —
   that's `release-loop`'s job, not this one; skip it here.

## Step 3 — merge

Merge with the repo's convention (detect via `release-and-branching`: gitflow
usually squash-into-`dev`; main-only per that repo) and delete the branch:

```
gh pr merge <n> --repo <repo> --squash --delete-branch    # or --merge per convention
```
Comment confirming the merge. On the merge itself failing, report it — never retry
a force.

## Step 4 — when a gate fails

Comment the **specific** blocker on the PR ("CI check `x` failing", "awaiting
approval", "conflicts with base — rebase needed"). By default **leave the
`auto-merge` label on** so the next run re-checks once the blocker clears. Remove
the label only for a hard, human-needed block (unresolvable conflicts, changes
requested) so the loop stops re-poking it — say which in the comment.

## Guardrails

- **Never merge without approved + green + mergeable + correct base.** No exceptions.
- **Never `--auto`, never force-merge, never merge a PR into `main` on a gitflow repo**
  (that's a release).
- **≤ 10 merges per run**; log any deferred.
- The `auto-merge` label is the *only* trigger — approval alone never merges.

## Running as a scheduled routine

Point it at the repos you want auto-merged and schedule it (e.g. every 30–60 min)
as a Claude Code cloud routine — it wakes, drains the `auto-merge` queue through the
gates, and stops. Author it for the REST path so it runs on a web runner where `gh`
is absent. *(Routine wiring is done separately.)*
