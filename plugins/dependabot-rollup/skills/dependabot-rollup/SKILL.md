---
name: dependabot-rollup
description: >-
  Consolidate a repo's open Dependabot **security** PRs (never majors) into one chore
  branch + PR, verify the bumps landed in the lockfile, drive it to green CI, close the
  superseded Dependabot PRs, and notify the human once. All work happens in a throwaway
  worktree, so the invoking checkout is never switched or dirtied. The rollup always lands
  on `dev`. Invoke as `/dependabot-rollup`, or whenever a repo's open Dependabot security
  PRs need consolidating into one verified rollup PR. Runs unattended as a scheduled **local**
  routine (never a cloud one — no Dependabot-alerts read). Requires the `github-ops` skill.
---

# dependabot-rollup

This file owns the **shape** of the run: the order of the steps and the branching
decisions. Each step's rules live in one reference file — read it when you reach that
step.

Before setting up or debugging a scheduled routine, read
[`references/unattended-operation.md`](references/unattended-operation.md): it covers the
`/goal` that carries the run across turns, the consent line the routine prompt must carry,
and why this is local-only.

## Discover on the default branch, open the rollup against `dev`

Dependabot raises security PRs on the repo's **default branch** (`$SOURCE`) —
`dependabot.yml`'s `target-branch` redirects only the scheduled *version* updates. Step 2
must discover there — discovering on `dev` instead finds routine version bumps only, and
reports a false `NO-OP`.

The rollup itself always opens against **`dev`**, cut from `origin/dev`, so it flows
through the normal release path; the Dependabot heads (cut from `$SOURCE`) merge into it.
No `dev` branch means no separate integration branch to protect — Dependabot's PRs already
merge straight to `$SOURCE` — so there's nothing for this skill to do: stop.

## Environment

**GitHub-API work** goes through the **`github-ops`** skill (`gh` locally, GitHub MCP on
Claude web); it must be available for this skill to run. Steps and references name the
*operation* — `github-ops` has the command. **Working-tree work** (merges, lockfiles,
install, build) needs a clone and the repo's toolchain locally, not just API access.

## Procedure

### 1. Preflight — resolve the repo, the default branch, and prior state

Confirm `github-ops` is present and auth is live (locally `gh auth status`; stop and report
if not). Then, **without changing branches**, run `scripts/preflight.sh`:

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/preflight.sh"
# no $CLAUDE_PLUGIN_ROOT (source checkout of the ops repo)?
bash plugins/dependabot-rollup/scripts/preflight.sh
```

It fetches, resolves `REPO` and `SOURCE` (the default branch — `origin/HEAD` is occasionally
unset), and confirms `origin/dev` exists — exiting loudly if either check fails, since no
`dev` means Dependabot's PRs already merge straight to `SOURCE` and there's nothing to roll
up. Take `REPO` and `SOURCE` from its output. Ignore `git status` — a dirty checkout is
fine and must not abort the run.

Then **list the open PRs on `dev`** (→ *List PRs by label / state*) looking for a
`chore/dependabot-security-rollup-*` head:

- **Green rollup PR already open** → it's waiting on review. Report
  `ALREADY AWAITING REVIEW` + link and **stop**. No second rollup, no rebase, no merge.
- **Red or pending rollup PR** → continue, and carry it to step 3, which reuses that branch.
- **None** → continue; step 3 cuts a new one.

### 2. Discover & classify → [`references/classification.md`](references/classification.md)

Discover on **`$SOURCE`**. Two outcomes:

- **Nothing to include** → quiet no-op. Stop here, before any worktree exists.
- **Otherwise** → set the `/goal`
  ([`references/unattended-operation.md`](references/unattended-operation.md)) and continue.

### 3. Create the throwaway worktree → [`references/worktree.md`](references/worktree.md)

Idempotent: new branch, or the existing one from step 1. Call the path `$WT` — steps 4–8
all run inside it.

### 4. Apply the bumps → [`references/lockfile-and-verification.md`](references/lockfile-and-verification.md)

### 5. Verify the bumps landed → same file — mandatory, never skipped

### 6. Commit & push

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/commit-and-push.sh"
# no $CLAUDE_PLUGIN_ROOT (source checkout of the ops repo)?
bash plugins/dependabot-rollup/scripts/commit-and-push.sh
```

### 7. Open (or update) the rollup PR → [`references/pr-and-completion.md`](references/pr-and-completion.md)

### 8. Drive to green, then close the superseded PRs → same file

Strictly in that order: the closes are the only thing standing between a failed rollup and
lost security fixes.

### 9. Tear down the worktree → [`references/worktree.md`](references/worktree.md)

Whenever a worktree was created — on success, on `NEEDS-ME`, and on any error or early stop
from step 3 onwards.

### 10. Notify → [`references/pr-and-completion.md`](references/pr-and-completion.md)

Once, at the end, and only once steps 8 and 9 are both done. Then `/goal clear`.
