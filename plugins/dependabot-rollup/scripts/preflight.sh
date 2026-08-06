#!/usr/bin/env bash
#
# preflight.sh — resolve the repo root and default branch, and confirm a `dev`
# branch exists (the rollup always opens against it; no `dev` means Dependabot's
# PRs already merge straight to the default branch, so there's nothing to roll up).
#
# Deterministic: no interactive prompts, fails loudly on any error.
# Run from anywhere inside the repo (including a linked worktree).
#
# Prints:  REPO=<path>
#          SOURCE=<default-branch-name>

set -euo pipefail

REPO=$(git rev-parse --show-toplevel)
cd "$REPO"
git fetch origin --prune

SOURCE=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
if [ -z "$SOURCE" ]; then
  echo "error: cannot resolve default branch (origin/HEAD unset in this clone)" >&2
  exit 1
fi

if ! git rev-parse --verify -q origin/dev >/dev/null; then
  echo "error: no dev branch — nothing to roll up, PRs merge straight to $SOURCE" >&2
  exit 1
fi

echo "REPO=$REPO"
echo "SOURCE=$SOURCE"
