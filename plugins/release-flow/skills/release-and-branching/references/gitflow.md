# Two-branch gitflow (`dev` + `main`)

Use this when the repo has both a `dev` branch **and** a `main` branch. The branches are
always `dev` and `main`.

## Branching (all work)
- **Start on latest `dev`.** Before creating a branch, get the main worktree onto an
  up-to-date `dev` — use the **`sync-dev`** skill (it resolves the main worktree, checks out
  `dev`, and pulls). That's the front door; everything below leads on from there.
- **Never commit directly to `dev` or `main`** — both are protected. Always work on a branch.
- Name the branch by type: **`feature/…`**, **`fix/…`**, **`chore/…`** (also `docs/…`,
  `refactor/…`, `test/…`).
- Branch off **`dev`**.

## Merging a normal PR → `dev`
- Open the PR against **`dev`**.
- After review + green CI, **always squash-merge** into `dev` (one tidy commit per PR).
- Delete the branch after merge (`gh pr merge --squash --delete-branch` removes the remote
  branch).
- **Then tidy the local repo** by running the cleanup script (from the main worktree):
  ```bash
  bash "$CLAUDE_PLUGIN_ROOT/scripts/post-merge-cleanup.sh" dev
  # fallback if $CLAUDE_PLUGIN_ROOT is unset (source checkout of the ops repo):
  bash plugins/release-flow/scripts/post-merge-cleanup.sh dev
  ```
  It switches to `dev`, fast-forwards to `origin/dev`, prunes stale remote-tracking refs, then
  deletes local branches whose PR was merged. It's **squash-aware**: since we always
  squash-merge, a merged branch's tip is never an ancestor of `dev` (so `git branch --merged`
  would miss it). Instead it finds branches whose upstream is `gone` (the remote branch was
  deleted by `gh pr merge --delete-branch`) and **confirms via `gh` that the head's PR state is
  `MERGED`** before deleting — confirmed-merged, never a blind delete. It aborts on a dirty
  working tree, skips protected branches (`dev`/`main`), skips any branch checked out in a
  worktree, and no-ops if `gh` isn't installed.
- If you **only** want to return to latest `dev` (no branch cleanup — e.g. you merged via the
  GitHub UI), use the lighter **`sync-dev`** skill instead. `post-merge-cleanup.sh` is the
  superset: it fast-forwards `dev` *and* deletes merged local branches.
- If the repo uses **git worktrees** (with their own databases / running processes), that
  teardown is destructive and repo-specific — use the repo's own cleanup flow (e.g. a
  `/cleanup` skill) instead. This skill deliberately leaves it out.

## Cutting a release
1. **Always create a release branch off `dev`:** `release/<version>` (e.g.
   `release/1.0.0-beta.30`).
2. Bump the version across **all** manifests + lockfile, and verify no stale version strings.
   The exact file list and verify command are repo-specific — follow the repo's `CLAUDE.md`
   (e.g. its *Releases → Release process* section); don't duplicate them here.
3. Open a PR from the release branch into **`main`**.
4. After green CI (release PRs often run extra suites — evals, E2E, etc.), **always use a merge
   commit — NOT squash —** when merging the release branch into `main`. The real
   merge/version-bump commit on `main` is what the tagging + sync automation keys off. Squashing
   it away would break both.

## When a CI check fails (tests or evals)
- **Never dismiss a red CI check as "flaky" from the dashboard alone, and never merge past it on
  a hunch.** Reproduce it locally first, using the *same* failing test/suite (commands live in
  the repo's `CLAUDE.md`/`README`).
- **Passes locally →** treat as flaky: note it, rerun the CI job to get green, then proceed.
- **Fails locally too →** it's real: fix it (or hold the release) before merging.
- LLM-driven suites (evals) are non-deterministic, so a single red eval is often flaky — but
  confirm it, don't assume it.

## After the release reaches `main`
Two pieces of automation should run (add them if missing — see `assets/`):
- **Tag + Release** (`assets/release-tag.yml`) creates the `v<version>` tag + GitHub Release.
- **Sync back to dev** (`assets/sync-main-to-dev.yml`) merges `main` back into `dev` (via a
  `chore/merge-main-to-dev` branch) so `dev` picks up the version bump and any release fixes.
- If the sync fails, do the merge-back-to-dev by hand (the repo's `CLAUDE.md` should document
  the manual steps).
- **Once `sync-main-to-dev` has merged, run the `sync-dev` skill** to bring your *local* `dev`
  up to date — the automation only updates `dev` on the remote, so your main worktree is behind
  until you pull. This closes out the release: remote `dev` has the release commits, and
  `sync-dev` gets them onto your machine ready for the next branch.

## Why two merge styles
- **Squash → `dev`** keeps day-to-day history to one commit per feature.
- **Merge commit → `main`** preserves the release branch's version-bump commit, which the tag
  automation and the `main`→`dev` sync rely on. Squashing a release into `main` would break
  that.
