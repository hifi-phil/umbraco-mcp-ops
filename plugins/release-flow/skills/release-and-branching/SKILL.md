---
name: release-and-branching
description: Branching, merge, and release workflow for any repo. Detects whether the repo uses a two-branch gitflow (dev + main) or a simpler main-only model, then follows the matching conventions for branch naming, squash vs merge-commit, cutting a release, and tagging. Use whenever creating a branch to do work, opening or merging a PR, cutting a release, merging a release into main, or setting up release-tag automation. Trigger on intents like "start a branch", "merge this PR", "cut/do a release", "release X", "merge to main".
---

# Branching & release workflow

This skill works in **any** repo. Do not assume a `dev` branch exists — first detect which
branching model the repo uses, then follow the matching reference file.

## Step 1 — the repo's own docs first

If the repo's `CLAUDE.md` (or `README`) documents its branching model, **that is the model**:
follow it, and skip the detection below. If it names a branch that doesn't exist on the
remote (`git ls-remote --heads origin <branch>` prints nothing), **stop and say so**. Never
fall back to `main` or another branch instead.

## Step 2 — otherwise, detect the model from the remote

Ask the **remote**, not the local clone: a cloud session or a CI job often starts from a
single-branch clone of the default branch, where `git branch -a` shows only `main` even
when `dev` exists.

```bash
git ls-remote --heads origin | sed 's#.*refs/heads/##' | sort -u
```

- Remote has **both** a `dev` branch **and** a `main` branch → **two-branch gitflow**. Read
  `references/gitflow.md`. Fetch `dev` before branching from it (`git fetch origin dev`).
- Remote has **only** `main`, no `dev` → **main-only**. Read `references/main-only.md`.
- Neither / mixed / genuinely unclear → **ask the user which model to follow** before doing
  anything. Never invent a `dev` branch.

## Rules common to both models

- **Never commit directly to a protected branch** (`main`, and `dev` where it exists). Always
  work on a branch.
- Name branches by type: `feature/…`, `fix/…`, `chore/…` (also `docs/…`, `refactor/…`,
  `test/…`).
- Open a PR; merge only after review + green CI.
- **When CI fails, reproduce it locally before deciding anything.** Never dismiss a red check
  as "flaky" from the dashboard, and never merge past a reproducible failure. If it passes
  locally, treat as flaky (rerun the job to green); if it fails locally, it's real — fix it or
  hold. The exact build/test commands are repo-specific — get them from the repo's `CLAUDE.md`
  or `README`.
- **Repo-specific details live in the repo, not here.** Version-bump file lists, test/build
  commands, and worktree/DB cleanup belong in the repo's `CLAUDE.md` — follow those, don't
  duplicate them in this skill.
- **After merging, tidy the local repo** with `scripts/post-merge-cleanup.sh <integration-branch>`
  (`dev` or `main` — the reference file for each model gives the exact invocation). It's safe to
  run unattended — see the script's own header/inline comments for exactly what it does and why.
  If you only want to
  return to the latest integration branch with no branch cleanup (e.g. you merged via the GitHub
  UI), the **`sync-dev`** skill is the lighter alternative for the gitflow model.

## Release tagging (both models)

A release finishes by tagging `v<version>` and creating a GitHub Release. **If the repo has no
automation for this, add it:** copy `assets/release-tag.yml` into `.github/workflows/` and
adjust the trigger branch + the version-source step for the repo's stack (see the file's own
header comment for its idempotency behavior). The reference file for each model says exactly
where tagging fits.
