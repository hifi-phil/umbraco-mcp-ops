#!/usr/bin/env bash
#
# sync-dev.sh — move to the repo's main worktree, switch to `dev`, and pull latest.
#
# Deterministic: no interactive prompts, fails loudly on any error.
# Run from anywhere inside the repo (including a linked worktree).

set -euo pipefail

# Must be inside a git repo.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git repository" >&2
  exit 1
fi

# The first entry of `git worktree list --porcelain` is always the main worktree.
MAIN_WT="$(git worktree list --porcelain | awk 'NR==1{print $2}')"
if [ -z "${MAIN_WT:-}" ] || [ ! -d "$MAIN_WT" ]; then
  echo "error: could not resolve main worktree path" >&2
  exit 1
fi

echo "==> main worktree: $MAIN_WT"
cd "$MAIN_WT"

echo "==> git checkout dev"
git checkout dev

echo "==> git pull"
git pull

echo
echo "==> done — on dev at $MAIN_WT"
git log --oneline -1
