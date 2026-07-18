---
name: release-and-branching
description: Branching, merge, and release workflow for any repo. Detects whether the repo uses a two-branch gitflow (dev + main) or a simpler main-only model, then follows the matching conventions for branch naming, squash vs merge-commit, cutting a release, and tagging. Use whenever creating a branch to do work, opening or merging a PR, cutting a release, merging a release into main, or setting up release-tag automation. Trigger on intents like "start a branch", "merge this PR", "cut/do a release", "release X", "merge to main".
---

# Branching & release workflow

This skill works in **any** repo. Do not assume a `dev` branch exists — first detect which
branching model the repo uses, then follow the matching reference file.

## Step 1 — detect the model

```bash
git branch -a --format='%(refname:short)' | sed 's#^origin/##' | sort -u
```

- Repo has **both** a `dev` branch **and** a `main` branch → **two-branch gitflow**. Read
  `references/gitflow.md`.
- Repo has **only** `main`, no `dev` → **main-only**. Read `references/main-only.md`.
- Neither / mixed / genuinely unclear → **ask the user which model to follow** before doing
  anything. Never invent a `dev` branch.

Gitflow here always means the branches `dev` and `main`.

If the repo's own `CLAUDE.md`/`README` documents a branching model, that wins over this
detection — follow it.

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

## Release tagging (both models)

A release finishes by tagging `v<version>` and creating a GitHub Release. **If the repo has no
automation for this, add it:** copy `assets/release-tag.yml` into `.github/workflows/` and
adjust the trigger branch + the version-source step for the repo's stack. The example is
idempotent — it only fires when the version actually changes (it skips if the tag exists).
The reference file for each model says exactly where tagging fits.
