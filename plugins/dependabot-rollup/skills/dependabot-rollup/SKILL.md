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
  `/dependabot-rollup [base branch]`; the base defaults to the repository's **default
  branch**, which is where Dependabot raises security PRs — not an integration branch
  like `dev`.
  Or trigger whenever you need to consolidate a repo's open Dependabot security PRs into one
  verified rollup PR. Sets a `/goal` so the run survives across turns.
  Requires the `github-ops` skill for all GitHub-API work.
---

# dependabot-rollup

Consolidate all **open Dependabot security updates** into one `chore/` branch + PR against the base branch, verify it to green CI, delete (close + delete-branch) the individual Dependabot PRs the rollup supersedes, and notify the human **only when everything is done**.

Built to run **unattended on a schedule locally**. The intended setup is a scheduled local routine whose entire prompt is `/dependabot-rollup`, pointed at one repo — so everything the run needs to decide lives here, not in the routine's prompt. One routine per repo: a local routine can only be given a single folder, and that folder also selects which `CLAUDE.md`, project settings, and permissions apply.

It must be a quiet no-op when there is nothing to do, and it must never lose work — neither the human's uncommitted changes (all work happens in a throwaway worktree, never in their checkout) nor the security fixes themselves (individual Dependabot PRs are closed **only after** the rollup PR's CI is fully green, and the lockfile is verified before that).

> **Local only — not a cloud routine.** The Claude GitHub App available to cloud routines has a fixed permission set with **no Dependabot-alerts read** (it can't be granted), so a cloud run can never tell which PRs are security and can only no-op. Run this locally, where `gh` has the scope. See the alerts-permission note in *Discover & classify*.

Invoke as `/dependabot-rollup [base branch]`. **The base defaults to the repository's default branch**, because that is where Dependabot raises security PRs — the rollup targets the same branch as the PRs it consolidates. Do not default to an integration branch like `dev`: `dependabot.yml`'s `target-branch` redirects only the scheduled *version* updates, so a `dev`-scoped run finds routine bumps and no security PRs at all.

In a `dev` + `main` repo the fix therefore lands on `main` first and reaches `dev` by the repo's normal main→dev sync — the same path the individual Dependabot PRs would have taken had they been merged one by one. Pass an explicit base only if a repo genuinely wants otherwise.

## GitHub access & environment

- **GitHub-API operations** (list Dependabot PRs, list Dependabot alerts, get/create/update/close PRs, CI status, read failing logs) go through the **`github-ops`** skill — `gh` locally, the GitHub MCP server on Claude web. **`github-ops` must be available for this skill to run.** The steps name the *operation*; `github-ops` has the command/tool.
- **Working-tree operations** (merging the include branches, reconciling lockfiles, `npm install`, building) use `git` + the ecosystem toolchain directly — these are **not** GitHub-API calls, so they need a **clone + the repo's toolchain** in the local environment (Node/.NET), not just API access.

## Guardrails (read first)

- **Security-only.** Include a Dependabot PR only if at least one package it bumps has an **open Dependabot security alert**. Routine (non-security) version-bump PRs are left untouched.
- **`$BASE` is the default branch.** Dependabot raises security PRs there, so the rollup targets the same branch as its inputs. Never point it at an integration branch like `dev` — that finds version bumps only, and reports a false `NO-OP`.
- **No major bumps — ever.** Exclude any PR whose targeted package crosses a **semver-major** boundary (e.g. `uuid 11 → 14`). This includes multi-package bundles where *any* bundled package is a major bump — if a bundle can't be split cleanly, defer the whole bundle. Majors are handled separately, one-to-one, by a human.
- **Never lose work.** Closing/deleting the individual Dependabot PRs happens **only after** CI on the rollup PR is green.
- **Never touch the human's checkout.** Do not `git switch`, `git checkout <branch>`, stash, reset, or pull in the invoking working tree — it may hold uncommitted work, a running dev server, or environment files. A dirty checkout is **not** a reason to abort: all branch work happens in a throwaway worktree (step 3), which is torn down on every exit path (step 9).
- **Never merge, never auto-merge.** The rollup PR is handed back green for human review. Do not merge it and do not enable auto-merge, whatever the run's outcome.
- **Verify the lockfile, don't trust the merge.** A clean merge + successful install does **not** mean the bumps landed — see step 5. Never open or update a PR claiming fixes you haven't asserted resolved versions for.
- **Quiet when idle.** If nothing is in scope, log the classification summary and stop — no worktree, no branch, no PR, no notification.
- **Notify once, at the end.** Ping the human to review exactly once, only when the rollup PR is open, CI is fully green, and the superseded PRs are closed.

## Run the whole thing under a `/goal`

`/goal` is a native Claude Code command — `/goal [condition|clear]` — that makes Claude keep working **across turns** until the condition holds. **Without it this skill does not survive an unattended run**: a rollup spans many turns (merges, installs, a CI wait, fix rounds), and a routine whose prompt is just `/dependabot-rollup` has nothing else to carry it past the first turn boundary.

So set the goal **as soon as step 2 finds work** — not at the CI loop, which is too late — covering the entire definition of done:

```
/goal a Dependabot security rollup PR is open on <REPO> against <BASE>, every targeted package verified at its expected resolved lockfile version, all CI checks green, every superseded Dependabot PR closed, the worktree torn down, and the outcome reported — the PR left unmerged
```

Fill in `<REPO>` and `<BASE>`, and add the PR number once step 7 has it. Then:

- **`/goal clear` on every terminal outcome** — `ROLLUP OPEN`, `NO-OP`, `ALREADY AWAITING REVIEW`, `NEEDS-ME`, or an abort. A goal left set makes the next run inherit a stale objective.
- Don't set a goal for a run that stops in step 1 or 2 (already-awaiting-review, or a quiet no-op) — there's nothing to persist.

## Procedure

### 1. Preflight — resolve the repo, base branch, and whether there's anything to do

Confirm GitHub access is available (`github-ops` — its mechanism is present) and that auth is live (locally: `gh auth status`; stop and report if not). Then, **without changing branches**:

```bash
REPO=$(git rev-parse --show-toplevel)
cd "$REPO"
git fetch origin --prune
# BASE = the base-branch argument if set; else the default branch:
BASE=${1:-$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')}
[ -n "$BASE" ] || { echo "cannot resolve default branch"; exit 1; }   # origin/HEAD unset in some clones
```

The repo is whatever the invoking working tree belongs to — that's what makes `/dependabot-rollup` viable as a whole routine prompt. Ignore `git status`: a dirty checkout is fine and must not abort the run.

Then check whether a previous run already left something for the human — **list the open PRs on `$BASE`** (`github-ops` → *List PRs by label / state*) and look for a `chore/dependabot-security-rollup-*` head branch. Keep the result; step 3 needs it.

- **Open rollup PR whose CI is already green** → it is waiting on review, and there is nothing to add. Report `ALREADY AWAITING REVIEW` with the link and **stop**. Do not open a second rollup, do not rebase it, do not merge it.
- **Open rollup PR that is red or pending** → continue; step 3 reuses that branch.
- **None** → continue; step 3 cuts a new branch.

### 2. Discover & classify

Via `github-ops`:

- **List the open Dependabot PRs** (→ *List open Dependabot PRs*) — number, title, head branch, base, url. Keep the ones based on `$BASE`.
- **List open Dependabot security alerts** (→ *List Dependabot security alerts*) — package name, severity, and `first_patched_version`, the version a fix has to reach.

If listing alerts fails with a **permission error** (the connected app / token lacks Dependabot-alerts read — this is **always** the case for the Claude GitHub App used by cloud routines, which is why this skill is local-only), **stop and report that limitation**. Do not guess which PRs are security.

For each open Dependabot PR, parse the package(s) and `from → to` versions from the title (get the PR via `github-ops` → *Get a PR* for multi-package bundles), then classify:

- **INCLUDE** — open security alert, no major bump, and the `to` version reaches the alert's `first_patched_version`.
- **DEFER-MAJOR** — security but crosses a major (or a bundle containing any major). Reported, never merged.
- **SKIP-NONSECURITY** — no open alert, or a bump that lands short of `first_patched_version`. Left alone.

Then walk the **alerts**, not the PRs: every open alert no INCLUDE PR resolves is an **UNCOVERED ALERT**. Dependabot raises no PR for a vulnerable **transitive** dependency that no manifest declares, so a PR-only walk drops those advisories silently. Record package, severity, and `first_patched_version`. They never make the run non-idle.

If **INCLUDE is empty**: print the classification summary and **stop** (quiet no-op) — before creating any worktree. Still surface any DEFER-MAJOR and UNCOVERED ALERTS as a lightweight note so a human can action them, but this is not the "review the PR" ping.

### 3. Create the throwaway worktree (idempotent)

All branch work happens in a worktree, so the human's checkout is never switched and never has to be clean.

**Use the repo's own worktree process — do not invent one here.** Worktrees are standardised across these repos, and the repo is the authority on how one is created: read its `CLAUDE.md` worktree section and use the mechanism it documents (typically the **`EnterWorktree`** tool, whose `WorktreeCreate` hook copies the files listed in `.worktreeinclude`, provisions the worktree's database, rewrites ports, and runs the install), or a repo-provided worktree skill if it has one. Following that process is what keeps the worktree consistent with every other worktree in the repo — and its hook-run install is work the rollup needs anyway.

Branch naming still comes from this skill: `chore/dependabot-security-rollup-<date>`, or the existing rollup branch found in step 1 when reusing.

Only if the repo documents **no** worktree process, fall back to plain `git worktree add` at a path the repo already gitignores — try `.claude/worktrees` then `.worktrees` via `git check-ignore -q`, and if neither is ignored, stop and ask for one to be added to `.gitignore`. Never place the worktree at an un-ignored in-repo path (it pollutes `git status`) or outside the repo (a local routine only has access to its one selected folder).

Clear a stale worktree from a crashed run first — via the repo's removal process (step 9), never a blind delete.

When reusing an existing rollup branch, rebase it onto latest `origin/$BASE` inside the worktree before merging anything new.

Call the resulting path `$WT`. Every remaining step runs inside it.

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

Body lists, per included package: name, `from → to` **as verified in step 5**, highest open advisory severity; a **Deferred (major — handle separately)** section with each DEFER-MAJOR PR number + link; an **Uncovered alerts** section (package, severity, required version); and a **Supersedes** line referencing every INCLUDE PR number.

### 8. Drive to green CI — THE LOOP

Update the `/goal` set earlier to name the rollup PR number now that it exists, then work the loop until the goal is met (GitHub actions via `github-ops`):

- Poll the rollup PR's **CI / check-run status** (→ *Get PR CI / check-run status*) until it settles, rather than busy-waiting.
- On any failure: **read the failing check's log** (→ *Read a failing check's log*), fix the root cause in code, commit, push, re-poll. Treat a CI failure as a real regression to fix — never hand a red PR to the human.
- **Only once CI is fully green**, **close each superseded Dependabot PR** (→ *Close a PR without merging (+ comment, delete branch)*) with a comment like `Superseded by #<ROLLUP> — rolled into the security rollup.`, then confirm it's closed (→ *Get a PR*). Deleting the merged branch is best-effort — if the environment can't delete it, `branch-housekeeping` will reap it.

The goal is not met — and you must not notify the human — until CI is green **and** every superseded PR is closed.

If CI can't be driven green after ~3 genuine fix attempts, **push what you have and stop** with `NEEDS-ME (CI red)` and the PR link. Leave the PR open — a red PR that's been reported is recoverable; a silently abandoned branch isn't.

### 9. Tear down the worktree — every exit path

Whenever a worktree was created, remove it — on success, on `NEEDS-ME`, and on any error or early stop from step 3 onwards.

**Use the repo's own worktree removal process**, matching however step 3 created it: the `ExitWorktree` tool with the remove action, or the repo's own cleanup skill (e.g. `/cleanup`) where it documents one. This matters more than creation did — in these repos teardown is destructive and repo-specific: the `WorktreeRemove` hook kills every process still holding files in the worktree (demo-site binaries re-parented to launchd included) and drops the worktree's database. A bare `git worktree remove` leaves both behind, so the directory won't free and the database leaks.

Only if the repo documents no removal process, fall back to:

```bash
cd "$REPO"
git worktree remove --force "$WT"
git worktree prune
```

Either way: only ever remove the `dependabot-rollup` worktree this run created; never another worktree in the repo. The branch stays on `origin`, so nothing is lost — only the local worktree goes, and the next run reuses the branch via step 3.

### 10. Notify — only now

Emit a single REVIEW-NEEDED summary: the rollup PR link, the count + names of included security fixes **with their verified resolved versions**, the list of closed/superseded PRs, the DEFER-MAJOR list with the reminder that majors are handled separately on a one-to-one basis, and the UNCOVERED ALERTS list. Send it as a push notification when running unattended.

Report exactly one outcome tag: `ROLLUP OPEN` / `NO-OP` / `ALREADY AWAITING REVIEW` / `NEEDS-ME (reason)`. Stay silent for `NO-OP`. Then `/goal clear`.

**Every `NO-OP` prints its evidence:** the branch you discovered on, how many Dependabot PRs it returned, and how many open alerts you reconciled against them. Open alerts that no PR fixes are still a `NO-OP` — but never a silent one.

## Success criteria

- ✅ One `chore/dependabot-security-rollup-*` PR open against `$BASE` — the default branch — with all in-scope security bumps.
- ✅ Every open alert accounted for — fixed by the rollup, deferred as a major, or reported as an uncovered alert.
- ✅ Every bump verified as a **resolved** lockfile version, with no entry moved backwards.
- ✅ All CI checks on that PR green.
- ✅ Every superseded individual Dependabot PR closed with its branch deleted.
- ✅ Zero major bumps merged; all majors reported for separate handling.
- ✅ The rollup PR left unmerged for human review.
- ✅ The human's checkout untouched — same branch, same uncommitted changes as before the run — and no leftover `dependabot-rollup` worktree (removed via the repo's own process).
- ✅ Human notified exactly once — or a quiet no-op if nothing was in scope.
- ✅ No `/goal` left set.
