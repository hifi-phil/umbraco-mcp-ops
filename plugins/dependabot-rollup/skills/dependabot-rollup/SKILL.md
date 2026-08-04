---
name: dependabot-rollup
description: >-
  Roll every open Dependabot SECURITY update (excluding semver-major bumps) into a
  single chore branch + PR, drive it to green CI with /goal, close (and delete the
  branch of) the individual Dependabot PRs the rollup supersedes, and notify only when
  everything is done. Repo-agnostic; all work happens in a throwaway git worktree, so the
  human's checkout is never switched, dirtied, or left on a chore branch. Safe to run
  unattended locally — a scheduled local routine whose entire prompt is
  `/dependabot-rollup` is the intended setup — but never as a cloud routine. Invoke as
  `/dependabot-rollup [base branch]`, or trigger whenever you need to consolidate a
  repo's open Dependabot security PRs into one verified rollup PR.
  Requires the `github-ops` skill for all GitHub-API work.
---

# dependabot-rollup

Consolidate all **open Dependabot security updates** into one `chore/` branch + PR against the base branch, verify it to green CI, delete (close + delete-branch) the individual Dependabot PRs the rollup supersedes, and notify the human **only when everything is done**.

Built to run **unattended on a schedule locally**. The intended setup is a scheduled local routine whose entire prompt is `/dependabot-rollup`, pointed at one repo — so everything the run needs to decide lives here, not in the routine's prompt. One routine per repo: a local routine can only be given a single folder, and that folder also selects which `CLAUDE.md`, project settings, and permissions apply.

It must be a quiet no-op when there is nothing to do, and it must never lose work — neither the human's uncommitted changes (all work happens in a throwaway worktree, never in their checkout) nor the security fixes themselves (individual Dependabot PRs are closed **only after** the rollup PR's CI is fully green, and the lockfile is verified before that).

> **Local only — not a cloud routine.** The Claude GitHub App available to cloud routines has a fixed permission set with **no Dependabot-alerts read** (it can't be granted), so a cloud run can never tell which PRs are security and can only no-op. Run this locally, where `gh` has the scope. See the alerts-permission note in *Discover & classify*.

Invoke as `/dependabot-rollup [base branch]`. The optional base branch defaults to `dev` when it exists on `origin`, otherwise the repository's default branch (detect via `github-ops` → *Detect base branch*).

## GitHub access & environment

- **GitHub-API operations** (list Dependabot PRs, list Dependabot alerts, get/create/update/close PRs, CI status, read failing logs) go through the **`github-ops`** skill — `gh` locally, the GitHub MCP server on Claude web. **`github-ops` must be available for this skill to run.** The steps name the *operation*; `github-ops` has the command/tool.
- **Working-tree operations** (merging the include branches, reconciling lockfiles, `npm install`, building) use `git` + the ecosystem toolchain directly — these are **not** GitHub-API calls, so they need a **clone + the repo's toolchain** in the local environment (Node/.NET), not just API access.

## Guardrails (read first)

- **Security-only.** Include a Dependabot PR only if at least one package it bumps has an **open Dependabot security alert**. Routine (non-security) version-bump PRs are left untouched.
- **No major bumps — ever.** Exclude any PR whose targeted package crosses a **semver-major** boundary (e.g. `uuid 11 → 14`). This includes multi-package bundles where *any* bundled package is a major bump — if a bundle can't be split cleanly, defer the whole bundle. Majors are handled separately, one-to-one, by a human.
- **Never lose work.** Closing/deleting the individual Dependabot PRs happens **only after** CI on the rollup PR is green.
- **Never touch the human's checkout.** Do not `git switch`, `git checkout <branch>`, stash, reset, or pull in the invoking working tree — it may hold uncommitted work, a running dev server, or environment files. A dirty checkout is **not** a reason to abort: all branch work happens in a throwaway worktree (step 3), which is torn down on every exit path (step 9).
- **Never merge, never auto-merge.** The rollup PR is handed back green for human review. Do not merge it and do not enable auto-merge, whatever the run's outcome.
- **Verify the lockfile, don't trust the merge.** A clean merge + successful install does **not** mean the bumps landed — see step 5. Never open or update a PR claiming fixes you haven't asserted resolved versions for.
- **Quiet when idle.** If nothing is in scope, log the classification summary and stop — no worktree, no branch, no PR, no notification.
- **Notify once, at the end.** Ping the human to review exactly once, only when the rollup PR is open, CI is fully green, and the superseded PRs are closed.

## Procedure

### 1. Preflight — resolve the repo, base branch, and whether there's anything to do

Confirm GitHub access is available (`github-ops` — its mechanism is present) and that auth is live (locally: `gh auth status`; stop and report if not). Then, **without changing branches**:

```bash
REPO=$(git rev-parse --show-toplevel)
cd "$REPO"
git fetch origin --prune
# BASE = the base-branch argument if set; else 'dev' if `git rev-parse --verify origin/dev` succeeds; else default branch
```

The repo is whatever the invoking working tree belongs to — that's what makes `/dependabot-rollup` viable as a whole routine prompt. Ignore `git status`: a dirty checkout is fine and must not abort the run.

Then check whether a previous run already left something for the human — **list the open PRs on `$BASE`** (`github-ops` → *List PRs by label / state*) and look for a `chore/dependabot-security-rollup-*` head branch. Keep the result; step 3 needs it.

- **Open rollup PR whose CI is already green** → it is waiting on review, and there is nothing to add. Report `ALREADY AWAITING REVIEW` with the link and **stop**. Do not open a second rollup, do not rebase it, do not merge it.
- **Open rollup PR that is red or pending** → continue; step 3 reuses that branch.
- **None** → continue; step 3 cuts a new branch.

### 2. Discover & classify

Via `github-ops`:

- **List the open Dependabot PRs** (→ *List open Dependabot PRs*) — number, title, head branch, url.
- **List open Dependabot security alerts** (→ *List Dependabot security alerts*) and collect the alerting package names.

If listing alerts fails with a **permission error** (the connected app / token lacks Dependabot-alerts read — this is **always** the case for the Claude GitHub App used by cloud routines, which is why this skill is local-only), **stop and report that limitation**. Do not guess which PRs are security.

For each open Dependabot PR, parse the package(s) and `from → to` versions from the title (get the PR via `github-ops` → *Get a PR* for multi-package bundles), then classify:

- **INCLUDE** — has an open security alert **and** no major bump.
- **DEFER-MAJOR** — security but crosses a major (or a bundle containing any major). Reported, never merged.
- **SKIP-NONSECURITY** — no open alert. Left alone.

If **INCLUDE is empty**: print the classification summary and **stop** (quiet no-op) — before creating any worktree. Still surface any DEFER-MAJOR items as a lightweight note so a human can action them, but this is not the "review the PR" ping.

### 3. Create the throwaway worktree (idempotent)

All branch work happens in a worktree, so the human's checkout is never switched and never has to be clean. Pick a location the repo **already gitignores**, so the worktree stays inside the folder a local routine is allowed to touch:

```bash
for CAND in .claude/worktrees .worktrees; do
  if git check-ignore -q "$CAND"; then WT_DIR="$CAND"; break; fi
done
# No ignored candidate → stop and report: ask for `.claude/worktrees/` to be added to .gitignore.
# Do not fall back to an un-ignored in-repo path (pollutes git status) or an out-of-repo path
# (a local routine only has access to its one selected folder).
WT="$REPO/$WT_DIR/dependabot-rollup"

# Clear a stale worktree left by a crashed run — only ever this path.
git worktree remove --force "$WT" 2>/dev/null; git worktree prune

# Reusing the open rollup branch found in step 1:
git worktree add "$WT" <that-branch>
# Otherwise, cut a fresh one from the base:
git worktree add "$WT" -b "chore/dependabot-security-rollup-$(date +%Y-%m-%d)" "origin/$BASE"

cd "$WT"
```

Use plain `git worktree add` — **not** the `EnterWorktree` tool. Repos in this family register `WorktreeCreate` hooks that provision databases, copy demo sites, and run installs; a dependency rollup needs none of that, and the hook fails outright when Docker isn't running.

When reusing an existing rollup branch, rebase it onto latest `origin/$BASE` inside the worktree before merging anything new.

Every remaining step runs inside `$WT`.

### 4. Apply the bumps

Capture exactly what Dependabot resolved (covers direct **and** transitive deps) by merging each INCLUDE branch, then reconcile deterministically:

```bash
for BRANCH in <each INCLUDE headRefName>; do
  git merge --no-edit "origin/$BRANCH" || {
    # Lockfile conflicts are expected when several PRs touch the same lockfile.
    # Keep OURS — the accumulating side, which holds every bump merged so far —
    # then relock against the merged manifests. NEVER --theirs: each Dependabot
    # branch is cut from the base, so its lockfile contains only its own bump,
    # and taking it wholesale silently reverts every preceding merge.
    git checkout --ours <lockfile>
    git add <lockfile>
    npm install            # reconciles the lock to the merged manifests
    git add -A && git commit --no-edit
  }
done
```

> **This is the bug that shipped a PR "fixing" eight advisories while fixing one.** With `--theirs`, a six-branch rollup silently reverted `shell-quote`, `fast-uri`, `linkify-it`, `hono` and `body-parser` to their pre-bump versions — only the last-merged branch survived. `npm install` does **not** repair it: the targets are transitive deps already satisfied by the stale lockfile, so npm has no reason to touch them. There is no error and no warning. Hence `--ours` + relock, and step 5.

Then reconcile the dependency tree with the ecosystem's install command (`npm install`, `pnpm install`, `yarn`, etc.). For **non-lockfile ecosystems** (NuGet `.csproj`, Go modules, etc.), apply the version bump to the manifest directly instead of merging — again only if non-major.

**Where a manifest range changed**, `--ours` + relock is not enough: npm keeps the pinned lockfile entry when the new declared range already permits the installed version. That produces impossible combinations (observed: `wrangler` pinned at 4.90.0 under a freshly-merged `^4.104.0` range). Run `npm update <pkg>` for those packages to realise the range.

**Never pipe an install or build into a filter** (`npm install | tail -3`, `… | grep -E "^added"`) — the pipeline reports the *filter's* exit status, so a failed install reads as success. An `ERESOLVE` failure was masked exactly this way and a broken lockfile got committed. Redirect if output is noisy, and check the exit code.

Sanity-check locally, then fix anything that breaks here:

- Use the repo's **fullest fast build**, not the narrowest — e.g. `npm run build:all` where it exists, not `npm run build`. A partial build leaves a stale `dist/` that makes snapshot tests pass locally and fail in CI on a fresh build (a false green that cost a CI round-trip).
- Run the **cheap integration suite** if the repo has one (e.g. `npm run test:integration`) on top of the build. This is not "let CI own it" pedantry: the one genuine regression in the run that produced this guidance was a `wrangler` bump that changed npm hoisting so the package landed in `template/node_modules/` instead of the root. Every unit suite passed; only the integration suite caught it. The full/slow suite still belongs to CI.

If one package is irreconcilable, drop just that package from the rollup and report it rather than blocking the whole batch.

### 5. Verify the bumps actually landed — mandatory

A clean merge and a successful install prove nothing (see step 4). Before committing the rollup:

- For **every** targeted package, assert the **resolved** version in the lockfile is the expected `to` version — not the declared range, the resolved entry.
- Diff the whole lockfile against `origin/$BASE`. Every changed entry should be a target or a direct transitive companion of one; an entry that moved *backwards* is the `--theirs` failure mode resurfacing.
- If any target is missing or reverted, fix it (`npm update <pkg>`, or re-merge that branch) and re-verify. Do **not** proceed to the PR with an unverified lockfile, and never list a package in the PR body that you haven't asserted.

### 6. Commit & push

```bash
git add -A
git commit -m "chore(deps): roll up Dependabot security updates"   # if merges left staged changes
git push -u origin HEAD
```

### 7. Open (or update) the rollup PR

**Create the rollup PR** against `$BASE` (`github-ops` → *Create a PR*), or if one
already exists, **update its body** (→ *Update a PR's body*). Title:
`chore(deps): security rollup (<date>)`.

Body lists, per included package: name, `from → to` **as verified in step 5**, highest open advisory severity; a **Deferred (major — handle separately)** section with each DEFER-MAJOR PR number + link; and a **Supersedes** line referencing every INCLUDE PR number.

### 8. Drive to green CI with /goal — THE LOOP

`/goal` is a native Claude Code command — `/goal [condition|clear]` — that makes Claude keep working **across turns** until the condition holds. Set it to the full definition of done (substitute the rollup PR number):

```
/goal rollup PR #<ROLLUP> targets <BASE>, all its CI checks are green, and every superseded Dependabot PR is closed with its branch deleted
```

Then work the loop until the goal is met (GitHub actions via `github-ops`):

- Poll the rollup PR's **CI / check-run status** (→ *Get PR CI / check-run status*) until it settles, rather than busy-waiting.
- On any failure: **read the failing check's log** (→ *Read a failing check's log*), fix the root cause in code, commit, push, re-poll. Treat a CI failure as a real regression to fix — never hand a red PR to the human.
- **Only once CI is fully green**, **close each superseded Dependabot PR** (→ *Close a PR without merging (+ comment, delete branch)*) with a comment like `Superseded by #<ROLLUP> — rolled into the security rollup.`, then confirm it's closed (→ *Get a PR*). Deleting the merged branch is best-effort — if the environment can't delete it, `branch-housekeeping` will reap it.

The goal is not met — and you must not notify the human — until CI is green **and** every superseded PR is closed. Use `/goal clear` if you abort.

If CI can't be driven green after ~3 genuine fix attempts, **push what you have and stop** with `NEEDS-ME (CI red)` and the PR link. Leave the PR open — a red PR that's been reported is recoverable; a silently abandoned branch isn't.

### 9. Tear down the worktree — every exit path

Whenever a worktree was created, remove it — on success, on `NEEDS-ME`, and on any error or early stop from step 4 onwards:

```bash
cd "$REPO"
git worktree remove --force "$WT"
git worktree prune
```

Only ever remove the `dependabot-rollup` worktree this run created; never another worktree in the repo. The branch stays on `origin`, so nothing is lost — only the local directory goes, and the next run reuses the branch via step 3.

### 10. Notify — only now

Emit a single REVIEW-NEEDED summary: the rollup PR link, the count + names of included security fixes **with their verified resolved versions**, the list of closed/superseded PRs, and the DEFER-MAJOR list with the reminder that majors are handled separately on a one-to-one basis. Send it as a push notification when running unattended.

Report exactly one outcome tag: `ROLLUP OPEN` / `NO-OP` / `ALREADY AWAITING REVIEW` / `NEEDS-ME (reason)`. Stay silent for `NO-OP`.

## Success criteria

- ✅ One `chore/dependabot-security-rollup-*` PR open against `$BASE` with all in-scope security bumps.
- ✅ Every bump verified as a **resolved** lockfile version, with no entry moved backwards.
- ✅ All CI checks on that PR green.
- ✅ Every superseded individual Dependabot PR closed with its branch deleted.
- ✅ Zero major bumps merged; all majors reported for separate handling.
- ✅ The rollup PR left unmerged for human review.
- ✅ The human's checkout untouched — same branch, same uncommitted changes as before the run — and no leftover `dependabot-rollup` worktree.
- ✅ Human notified exactly once — or a quiet no-op if nothing was in scope.
