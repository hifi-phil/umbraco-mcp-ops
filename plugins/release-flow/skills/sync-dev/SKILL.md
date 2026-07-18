---
name: sync-dev
description: Move to the repo's main worktree, switch to the `dev` branch, and pull latest. Use when the user says "move/go back to dev", "switch to dev and pull", "get latest on dev", or otherwise wants the main worktree reset to an up-to-date dev branch.
---

# sync-dev

Switches the repository's **main worktree** to the `dev` branch and pulls the latest changes.

## What it does

Runs `scripts/sync-dev.sh`, which deterministically:

1. Resolves the main worktree (the first entry of `git worktree list`) — so this works even when invoked from a linked worktree.
2. `cd`s into that main worktree.
3. `git checkout dev`
4. `git pull`
5. Prints the resulting HEAD commit.

The script uses `set -euo pipefail`, so it stops at the first error (e.g. a dirty working tree blocking checkout) instead of continuing.

## How to run

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/sync-dev.sh"
```

If `$CLAUDE_PLUGIN_ROOT` is not set (e.g. running from a source checkout of the
ops repo rather than the installed plugin), use the plugin's own path:

```bash
bash plugins/release-flow/scripts/sync-dev.sh
```

## Notes

- Report the script's output to the user (final branch + HEAD commit).
- If the script fails because of uncommitted changes, surface that and ask how to proceed — do **not** stash or discard automatically.

## Relationship to `release-and-branching`

This skill just gets the main worktree onto an up-to-date `dev`. It sits at two points in the `release-and-branching` gitflow:

- **After a release — the canonical trigger.** Once the `sync-main-to-dev` automation has merged `main` back into `dev` (with the version bump + release fixes), remote `dev` is ahead of your local `dev`. Run this skill to pull those release commits down, closing out the release and leaving you ready for the next branch.
- **Front door before starting work.** Getting onto fresh `dev` is also the natural first step before creating a branch — from here, `release-and-branching` leads on with branch naming, squash-merging, cutting releases, and tagging.

It's also the lighter alternative to that skill's `post-merge-cleanup.sh` when you only want to return to latest `dev` **without** deleting merged branches (e.g. after merging via the GitHub UI). If you *do* want the branch cleanup too, run `post-merge-cleanup.sh` from `release-and-branching` — it fast-forwards `dev` and deletes merged local branches in one go.
