# Two-branch gitflow (`dev` + `main`)

Use this when the repo has both a `dev` branch **and** a `main` branch.

## Branching (all work)
- **Start on latest `dev`.** Before creating a branch, get the main worktree onto an
  up-to-date `dev` — use the **`sync-dev`** skill (it resolves the main worktree, checks out
  `dev`, and pulls). That's the front door; everything below leads on from there.
- Branch off **`dev`**.

## Merging a normal PR → `dev`
- Open the PR against **`dev`**.
- After review + green CI, **always squash-merge** into `dev` (one tidy commit per PR).
- Delete the branch after merge (`gh pr merge --squash --delete-branch` removes the remote
  branch).
- **Then tidy the local repo** (from the main worktree) — see SKILL.md's common rules for what
  the cleanup script does:
  ```bash
  bash "$CLAUDE_PLUGIN_ROOT/scripts/post-merge-cleanup.sh" dev
  # fallback if $CLAUDE_PLUGIN_ROOT is unset (source checkout of the ops repo):
  bash plugins/release-flow/scripts/post-merge-cleanup.sh dev
  ```
- Worktree/DB teardown isn't handled by the script — see SKILL.md's common rules for why.

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

## When a CI check fails
Same rule as always — see SKILL.md's common rules. Release PRs often add eval/E2E suites (see
*Cutting a release* step 4): LLM-driven suites (evals) are non-deterministic, so a single red
eval is often flaky — but confirm it, don't assume it.

## After the release reaches `main`
Two pieces of automation should run (add them if missing — see `assets/`):
- **Tag + Release** (`assets/release-tag.yml`) — see SKILL.md's *Release tagging* section for
  what it does and how to add it.
- **Sync back to dev** (`assets/sync-main-to-dev.yml`) — see the file's own header comment for
  what it does and how.
- If the sync fails, do the merge-back-to-dev by hand (the repo's `CLAUDE.md` should document
  the manual steps).
- **Once `sync-main-to-dev` has merged, run the `sync-dev` skill** — the automation only
  updates `dev` on the remote, so your main worktree needs it too before the next branch.
