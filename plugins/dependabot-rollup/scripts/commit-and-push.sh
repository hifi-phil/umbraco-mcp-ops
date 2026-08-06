#!/usr/bin/env bash
#
# commit-and-push.sh — commit the rollup (if step 4's merges left anything staged)
# and push the current branch.
#
# Deterministic: no interactive prompts, fails loudly on any error.
# Run from inside the rollup worktree, on the rollup branch.

set -euo pipefail

git add -A

if git diff --cached --quiet; then
  echo "==> nothing staged (merges applied cleanly, no relock needed) — skipping commit"
else
  git commit -m "chore(deps): roll up Dependabot security updates"
fi

git push -u origin HEAD
