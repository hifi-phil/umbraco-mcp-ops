# Classification — the canonical rules

**This file is the single definition of how a branch is classified.** Two things execute it:

- `scripts/sweep.sh` — the local path, where `gh` is available.
- **you**, via the GitHub MCP tools, on the cloud path where `gh` isn't (see `github-ops`).

Two executions, one set of rules. If you change anything here, change `sweep.sh` to match in
the same PR — a divergence would mean a branch is reported differently depending on where the
run happened, which is worse than either answer alone.

## Step A — repo facts

Per repo (github-ops → *Get repo metadata*; on the MCP path that's `search_repositories` with
`repo:OWNER/NAME` and **`minimal_output: false`**, which is required — the minimal shape omits
`delete_branch_on_merge`):

- **`archived: true`** → skip the repo entirely and name it. You can't act on it.
- **`delete_branch_on_merge: false`** → add the repo to the *setting off* list. This is the
  most actionable finding there is, because turning it on removes the need to clean up.
- **`default_branch`** → a protection guard, below.

A repo you **cannot read** is a gap, not an absence — record it and report it. Never let an
unreadable repo pass as a clean one.

## Step B — the protected set (three guards)

List the repo's branches (github-ops → *List branches*), paging until exhausted; each entry
carries `protected` and the tip commit sha. A branch is skipped **without comment** if **any**
of these holds:

1. it's in that repo's list in [`../../../scripts/repos.conf`](../../../scripts/repos.conf);
2. it equals the repo's live `default_branch`;
3. its entry reports `protected: true`.

Check all three independently, every run. **Never collapse them**, and don't assume 2 and 3
carry the load — `Umbraco-CMS-MCP-Editor` has no branch protection at all, so there guard 3 is
inert and `dev` is held only by guard 1.

## Step C — find each branch's newest PR

For every non-protected branch, take the **highest-numbered** PR with that branch as head,
across **all** states (github-ops → *List PRs*, which supports `head: OWNER:BRANCH` and
`state: all`). A branch can have several; only the newest decides.

Efficiency, not correctness: fetching the repo's PRs once (`state: all`, sorted by `updated`
desc, up to the page cap) and matching heads locally costs far fewer calls than one lookup per
branch. Fall back to a per-branch `head:`-filtered lookup for anything the pre-fetch missed.

Record from that PR: `number`, `state`, `merged_at`, **`head.sha`**, and `base.ref`.

## Step D — the categories

| Finding | Category |
|---|---|
| newest PR is `open` | **OPEN** |
| PR closed, has `merged_at`, **and branch tip == PR `head.sha`** | **MERGED** — safe to remove |
| PR closed, has `merged_at`, **but branch tip != PR `head.sha`** | **REUSED** — *not* safe |
| PR closed, `merged_at` is null | **CLOSED-unmerged** |
| no PR has this branch as head | **NO-PR** |

**`merged_at` is the only merge signal.** Not `state: closed`, and never git ancestry — these
repos squash-merge, so a merged branch is *not* an ancestor of its base and any
containment/`--merged` check silently misses it. That is the whole reason this reads PR state.

### The reuse guard is the subtle one

A merged PR does **not** mean the branch is disposable. Recurring branches —
`chore/merge-main-to-dev`, `merge/v17-*` — get pushed to again after their PR merges, so they
can hold commits that were never merged anywhere.

A containment check can't distinguish this from a legitimate squash merge, because neither is
an ancestor of the base. The signal that does work: **a closed PR's `head.sha` is frozen at
what it actually merged.** Tip still equal → nothing pushed since → disposable. Tip different
→ the branch moved on → **report it, never remove it.**

Real case: `chore/merge-main-to-dev` on `Umbraco-MCP-Base`, PR #251 merged 2026-07-31, then
reused — 2 commits ahead of `dev` including a security rollup. "Newest PR is merged" was true;
"safe to delete" was false.

Measure its divergence against **the PR's own `base.ref`**, not the repo default: these PRs
target `dev` or `v17/dev`, so comparing against `main` reports a number for the wrong branch.

## Step E — what each category means for the report

| Category | Reported as |
|---|---|
| **OPEN** | A **count only** — no names. Active work, including Dependabot. |
| **MERGED** | *Safe to remove.* What `/clean-branches` would delete. |
| **REUSED** | *Needs review* — with the divergence count and a compare link. Never as safe. |
| **CLOSED-unmerged** | *Needs review* — with the PR link and the branch's last-commit date. |
| **NO-PR** | *Needs review* — with a tree link and the last-commit date. |

Last-commit dates as `YYYY-MM-DD`; it's the signal a human uses to judge the review items. A
branch that vanishes mid-run reads `unknown`, never `null`.

## Caps

| Thing | Value |
|---|---|
| Branches classified per repo per run | **200** |
| Newest PRs pre-fetched per repo | **500** (5 pages of 100) |

These bound a run; they don't define completeness. Exceeding the branch cap is a **coverage
gap** and must be reported with the uncovered count. Exceeding the PR pre-fetch is not — those
branches fall through to the per-branch lookup and are still classified correctly.

`sweep.sh` holds these as `BRANCH_CAP` and `PR_PAGES`. Keep them in step.
