# Sweep scope — where it lives, and why the protected lists look like that

## The values live in one place only

[`scripts/repos.conf`](../../../scripts/repos.conf) is the **single source of truth** for which
repos are swept and which branches are never touched. Both `sweep.sh` and `reap.sh` read it.
This file explains it; it deliberately does **not** repeat the values, because two copies of a
protected-branch list is how a branch gets deleted by accident.

Changing scope means editing `repos.conf` in a PR — never hand-editing a live routine's prompt.

All configured repos are swept in **one run**, producing one digest. Pass `OWNER/REPO`
arguments to `sweep.sh` only to narrow a one-off investigation.

## The three guards

A branch is skipped if **any** of these holds, checked independently every run:

1. it's in that repo's list in `repos.conf`;
2. it is the repo's **live default branch** (read from the API, not assumed);
3. it reports **live GitHub branch protection**.

`reap.sh` re-applies all three immediately before deleting, *plus* re-verifies MERGED against
the API — so a stale `merged.tsv` can only cause a skip, never a wrong delete.

**Don't assume guards 2 and 3 always cover you.** They're only as good as each repo's
configuration. `Umbraco-CMS-MCP-Editor` has **no branch protection at all** — `main` and `dev`
both report `protected: false` — so on that repo guard 3 is inert and `dev` is held *only* by
its `repos.conf` row. The three guards are defence in depth, not three independent certainties.
Enabling branch protection on Editor would be a real improvement, independent of this skill.

## Why the entries are what they are

So nobody "tidies" them away:

- **`v17/dev` and `v17/main` are live maintenance lines** on both CMS repos. Both classify as
  **MERGED**, because each has been the *head* of a merge-back PR (Dev #317, Editor #61). Without
  their `repos.conf` rows they would be delete candidates — a live release line. This is the
  single most important reason the list exists.
- **`v16`** is on `Umbraco-CMS-MCP-Dev` only, and is dormant rather than dead (last commit
  2025-11-20). Keep it protected.
- **`v18/dev` does not exist yet** on either repo. The entry is deliberate and forward-looking:
  a protected name matching nothing is a harmless no-op, and it covers the branch the day
  someone cuts it.
- **`release/*` branches are not protected**, and that's intentional — a merged release branch
  should be reaped. Unmerged ones (`release/18.0.0-rc.1`, `release/17.5.1`) have no PR, so they
  land in the review list rather than being deleted.

## The repo setting does the real work

GitHub's per-repo **"Automatically delete head branches"** (Settings → General → Pull Requests)
reaps merged branches at merge time, for free. `sweep.sh` reads `delete_branch_on_merge` for
every repo and flags any that has it off.

As of 2026-08-06 all three swept repos have it **on**, and the effect is visible: `Umbraco-MCP-Base`
went from 13 merged leftovers to 1 in three days. Treat that as a snapshot — the sweep re-reads
it live every run, so the digest is the authority, not this paragraph.

That's why this skill's ongoing value is mostly the **review categories** and the settings
check. The reap matters for the pre-setting backlog, branches merged outside a PR, and any repo
where the setting gets switched back off.

## Caps

Both are in `sweep.sh` as `BRANCH_CAP` and `PR_PAGES`:

| Thing | Value |
|-------|-------|
| Branches classified per repo per run | **200** |
| Newest PRs pre-fetched per repo for the head→PR map | **500** (5 pages of 100) |

`Umbraco-CMS-MCP-Dev` passed 300 PRs on 2026-08-03, which is why the map cap is 500. Exceeding
it is not a correctness problem — branches the map misses fall through to a per-branch
`head:`-filtered lookup — it just costs extra calls. Raise it when a repo outgrows it.

Exceeding `BRANCH_CAP` **is** a coverage gap, so `sweep.sh` reports the uncovered count in the
digest rather than truncating silently.

## Slack destination

The digest goes to **`#umbraco-mcp-housekeeping`**.
