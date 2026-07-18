# Main-only (squash branches straight into `main`)

Use this when the repo has a **single** long-lived branch, `main`, and no `dev`. This is the
simpler model: there's no integration branch to stage work on and no `main`→`dev` sync to
preserve, so branches squash directly into `main`.

## Branching (all work)
- **Never commit directly to `main`** — it's protected. Always work on a branch.
- Name the branch by type: **`feature/…`**, **`fix/…`**, **`chore/…`** (also `docs/…`,
  `refactor/…`, `test/…`).
- Branch off **`main`**.

## Merging a PR → `main`
- Open the PR against **`main`**.
- After review + green CI, **squash-merge** into `main` (one tidy commit per PR).
- Delete the branch after merge: `gh pr merge --squash --delete-branch`.
- **Then tidy the local repo** by running the cleanup script with `main` as the integration
  branch:
  ```bash
  bash "$CLAUDE_PLUGIN_ROOT/scripts/post-merge-cleanup.sh" main
  # fallback if $CLAUDE_PLUGIN_ROOT is unset (source checkout of the ops repo):
  bash plugins/release-flow/scripts/post-merge-cleanup.sh main
  ```
  It switches to `main`, fast-forwards to `origin/main`, prunes stale remote-tracking refs, then
  deletes local branches whose PR was **confirmed `MERGED` via `gh`** (squash-aware, never a
  blind delete). It aborts on a dirty working tree and skips protected branches.

## Cutting a release
No separate `dev` means the flow is short:
1. Branch off `main`: `release/<version>` (or just `chore/release-<version>`).
2. Bump the version across all manifests + lockfile; verify no stale version strings. The exact
   file list / verify command are repo-specific — follow the repo's `CLAUDE.md`/`README`.
3. Open the PR into **`main`** and, after green CI, **squash-merge** it like any other PR.
   - Unlike gitflow, a **merge commit is not required** here — there's no `dev` to sync back to
     and no separate branch history to preserve. The squash commit on `main` carries the version
     bump, which is all the tag automation needs.

## After the release reaches `main`
- The **Tag + Release** automation (`assets/release-tag.yml`) creates the `v<version>` tag +
  GitHub Release from the version-bump commit on `main`. **If the repo has no such workflow, add
  it** — copy `assets/release-tag.yml` into `.github/workflows/` and adjust the version-source
  step for the repo's stack.
- There is **no `sync-main-to-dev` step** in this model (there's no `dev`). Ignore
  `assets/sync-main-to-dev.yml` — it's gitflow-only.

## When a CI check fails
Same rule as always: **reproduce locally before deciding anything.** Never dismiss a red check
as "flaky" from the dashboard, never merge past a reproducible failure. Passes locally → rerun
to green; fails locally → fix it or hold. Commands live in the repo's `CLAUDE.md`/`README`.
