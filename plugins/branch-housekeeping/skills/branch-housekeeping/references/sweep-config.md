# Sweep scope — where it lives, and why the protected lists look like that

## The values live in one place only

[`scripts/repos.conf`](../../../scripts/repos.conf) is the **single source of truth** for which
repos are swept and which branches are never touched. Both `sweep.sh` and `reap.sh` read it.
This file explains it; it deliberately does **not** repeat the values, because two copies of a
protected-branch list is how a branch gets deleted by accident.

Changing scope means editing `repos.conf` in a PR — never hand-editing a live routine's prompt.

All configured repos are swept in **one run**, producing one digest. Pass `OWNER/REPO`
arguments to `sweep.sh` only to narrow a one-off investigation.

Everything reads this file: the **report** (`sweep.sh` locally, the MCP path in a cloud
routine) and the **cleanup** (`reap.sh`, run only by `/clean-branches`). One scope, three
executions.

## The rules are not here

How a branch is classified — the three protection guards, the PR-state categories, the reuse
guard, the caps — lives in **[`classification.md`](classification.md)**, which is canonical for
every path. This file covers only **scope**: which repos, which branches are exempt, and why
those particular entries.

`reap.sh` additionally re-derives all of it from the API immediately before deleting, so a stale
candidate list can only cause a skip, never a wrong delete.

One thing worth repeating here, because it's about *these* repos rather than the algorithm:
**don't assume the live guards carry the load.** `Umbraco-CMS-MCP-Editor` has **no branch
protection at all** — `main` and `dev` both report `protected: false` — so on that repo the
protection guard is inert and `dev` is held *only* by its `repos.conf` row below. Enabling branch
protection there would be a real improvement, independent of this skill.

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

That's why the **report** is the part with ongoing value — the review categories and the
settings check — and why cleanup is an occasional, manual `/clean-branches`. What's left for it
to do is narrow: the pre-setting backlog, branches merged outside a PR, and any repo where the
setting gets switched back off. If you find yourself wanting to schedule the cleanup, check the
settings line in the digest first; that's almost always the real fix.

## Caps

The values live in [`classification.md`](classification.md) (and in `sweep.sh` as `BRANCH_CAP`
and `PR_PAGES`) — not here, so there's one number to change.

The only scope-specific note: `Umbraco-CMS-MCP-Dev` passed 300 PRs on 2026-08-03, which is why
the PR pre-fetch cap is 500 rather than 300. Raise it again when a repo outgrows it.

## Slack destination

The digest goes to **`#umbraco-mcp-housekeeping`**.
