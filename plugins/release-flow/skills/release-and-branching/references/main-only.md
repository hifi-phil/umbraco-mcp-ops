# Main-only (squash branches straight into `main`)

Use this when the repo has a **single** long-lived branch, `main`, and no `dev`. This is the
simpler model: there's no integration branch to stage work on and no `main`→`dev` sync to
preserve, so branches squash directly into `main`.

## Branching (all work)
Branch off **`main`**.

## Merging a PR → `main`
- Open the PR against **`main`**.
- After review + green CI, **squash-merge** into `main` (one tidy commit per PR).
- Delete the branch after merge: `gh pr merge --squash --delete-branch`.
- **Then tidy the local repo** with `main` as the integration branch — see SKILL.md's common
  rules for what the cleanup script does:
  ```bash
  bash "$CLAUDE_PLUGIN_ROOT/scripts/post-merge-cleanup.sh" main
  # fallback if $CLAUDE_PLUGIN_ROOT is unset (source checkout of the ops repo):
  bash plugins/release-flow/scripts/post-merge-cleanup.sh main
  ```

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
- Add the **Tag + Release** automation if missing — it fires from the version-bump commit on
  `main` (see SKILL.md's *Release tagging* section).
- There is **no `sync-main-to-dev` step** in this model (there's no `dev`). Ignore
  `assets/sync-main-to-dev.yml` — it's gitflow-only.

## When a CI check fails
Same rule as always — see SKILL.md's common rules.
