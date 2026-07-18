#!/usr/bin/env bash
#
# post-merge-cleanup.sh - tidy the local repo after a PR has been
# squash-merged into `dev` (and its remote branch deleted by `gh`).
#
# Does ONLY the safe, universal part of cleanup:
#   1. switch to dev and fast-forward to origin/dev
#   2. prune stale remote-tracking refs for branches deleted on the remote
#   3. delete local branches whose PR was merged (remote branch now gone)
#
# Step 3 is squash-aware: a squash-merged branch tip is never an ancestor
# of dev, so `git branch --merged` misses it. Instead we look for local
# branches whose upstream is "gone" (the remote branch was deleted, which
# `gh pr merge --delete-branch` does) AND confirm via `gh` that the head's
# PR is actually MERGED before deleting. Confirmed-merged, not a blind -D.
#
# It deliberately does NOT touch worktrees, databases, or running
# processes - that teardown is destructive and repo-specific; use the
# `/cleanup` skill (WorktreeRemove hook) for stale worktrees instead.
#
# Usage:  bash post-merge-cleanup.sh [integration-branch]   (default: dev)

set -euo pipefail

INTEGRATION="${1:-dev}"
PROTECTED=("$INTEGRATION" "main" "master")

# --- must be inside a git repo -------------------------------------------
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git repository" >&2
  exit 1
fi

# --- refuse to run with a dirty working tree (checkout would carry it) ----
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree has uncommitted changes - commit/stash first" >&2
  git status --short
  exit 1
fi

# --- 1. switch to integration branch and fast-forward --------------------
echo ">> switching to '${INTEGRATION}' and fast-forwarding"
git checkout "${INTEGRATION}"
git pull --ff-only origin "${INTEGRATION}"

# --- 2. drop stale remote-tracking refs (marks merged branches "gone") ---
echo ">> pruning stale remote-tracking refs"
git fetch --prune --quiet

# --- 3. delete local branches whose merged PR is gone from the remote ----
echo ">> deleting local branches whose merged PR is gone from the remote"
deleted=0
skipped=0
if ! command -v gh >/dev/null 2>&1; then
  echo "  - gh CLI not found; skipping branch deletion (nothing removed)"
else
  while IFS=' ' read -r branch track; do
    [ -z "${branch}" ] && continue
    # only branches whose upstream was deleted on the remote
    [ "${track}" = "[gone]" ] || continue
    # skip protected branches
    for p in "${PROTECTED[@]}"; do
      [ "${branch}" = "${p}" ] && continue 2
    done
    # confirm via the API that this head's PR was actually MERGED
    merged_count="$(gh pr list --head "${branch}" --state merged --json number --jq 'length' 2>/dev/null || echo 0)"
    if [ "${merged_count:-0}" = "0" ]; then
      echo "  - skipped '${branch}' (upstream gone, but no MERGED PR found)"
      skipped=$((skipped + 1))
      continue
    fi
    # -D is required (squash-merged tip isn't an ancestor), but we only
    # reach here for API-confirmed-merged branches. Fails if checked out
    # in another worktree -> caught and skipped.
    if git branch -D "${branch}" >/dev/null 2>&1; then
      echo "  - deleted '${branch}' (PR merged, remote branch gone)"
      deleted=$((deleted + 1))
    else
      echo "  - skipped '${branch}' (checked out in a worktree?)"
      skipped=$((skipped + 1))
    fi
  done < <(git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads)
fi

echo ""
echo "done: ${deleted} branch(es) deleted, ${skipped} skipped."
echo "note: for stale worktrees + their databases, use the /cleanup skill."
