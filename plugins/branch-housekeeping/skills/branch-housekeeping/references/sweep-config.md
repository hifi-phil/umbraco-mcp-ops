# Sweep config — which repos, and what must never be touched

The authoritative list of repos the weekly `branch-housekeeping` sweep covers, and the
branches that are protected in each. Changing the sweep's scope means editing **this
file** (in a PR) — never hand-editing a live routine's prompt.

Protection here is only the **first** of three guards. A branch is also protected if it
is the repo's default branch, or carries GitHub branch protection — both read live from
the API at run time.

**Don't assume the other two guards always cover you.** They're only as good as the repo's
configuration, and `Umbraco-CMS-MCP-Editor` currently has no branch protection at all (see
the note below), so on that repo this table is the *only* thing standing behind `dev`. The
three guards are defence in depth, not three independent certainties.

## Repos

All three are in scope. The sweep is **report-only**, so there is no trial scoping to do —
a wrong entry here costs a noisy digest line, not a lost branch.

| Repo | Protected branches (in addition to the live guards) |
|------|------------------------------------------------------|
| `umbraco/Umbraco-MCP-Base` | `main`, `dev` |
| `umbraco/Umbraco-CMS-MCP-Dev` | `main`, `dev`, `v16`, `v17/dev`, `v17/main`, `v18/dev` |
| `umbraco/Umbraco-CMS-MCP-Editor` | `main`, `dev`, `v17/dev`, `v17/main`, `v18/dev` |

Notes on those entries, so nobody "tidies" them away:

- **`v17/dev` and `v17/main` are live maintenance lines** on both repos (commits within the
  last fortnight as of 2026-08-03). They have no PR of their own, so without an entry here
  they'd show up in the review list every single week as permanent noise.
- **`v16`** exists on `Umbraco-CMS-MCP-Dev` only, and is dormant rather than dead
  (last commit 2025-11-20) — keep it protected.
- **`v18/dev` does not exist yet** on either repo. The entry is deliberate and
  forward-looking: a protected-branch name that matches nothing is a harmless no-op, and
  it means the branch is covered the day someone cuts it.
- **`Umbraco-CMS-MCP-Editor` has no GitHub branch protection at all** — even `main` and
  `dev` report `protected: false`. On that repo, guard 3 does nothing: `main` is held only
  by the default-branch guard and `dev` only by the row above. Fine while the sweep is
  report-only; **re-read this note before ever pointing the local reap at Editor.**

## Repo settings status

`delete_branch_on_merge` as of 2026-08-03 — the sweep re-reads this live every run and
flags whatever is off, so treat this as a snapshot, not the source of truth:

| Repo | Setting |
|------|---------|
| `umbraco/Umbraco-MCP-Base` | **off** — needs turning on |
| `umbraco/Umbraco-CMS-MCP-Dev` | on |
| `umbraco/Umbraco-CMS-MCP-Editor` | on |

## Slack destination

The digest goes to **`#umbraco-mcp-housekeeping`**.

## Caps

| Thing | Value |
|-------|-------|
| Branches classified per repo per run | **200** (log the remainder rather than silently truncating) |
| Newest PRs pre-fetched per repo to build the head→PR map | **500** (5 pages of 100) |

`Umbraco-CMS-MCP-Dev` was already past 300 PRs on 2026-08-03, which is why the map cap is
500. Exceeding it isn't a correctness problem — branches the map misses fall through to the
per-branch `head:`-filtered lookup — it just costs extra calls, so raise the cap again when
a repo outgrows it.
