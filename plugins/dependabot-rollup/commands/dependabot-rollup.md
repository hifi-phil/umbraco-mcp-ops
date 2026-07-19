---
description: Roll every open Dependabot SECURITY update (excluding semver-major bumps) into a single chore branch + PR, drive it to green CI with /goal, close (and delete the branch of) the individual Dependabot PRs the rollup supersedes, and notify only when everything is done. Repo-agnostic; safe to run unattended as a scheduled cloud routine.
argument-hint: "[base branch — defaults to 'dev' if it exists on origin, else the repo default branch]"
---

# /dependabot-rollup

Consolidate all **open Dependabot security updates** into one `chore/` branch + PR against the base branch, verify it to green CI, delete (close + delete-branch) the individual Dependabot PRs the rollup supersedes, and notify the human **only when everything is done**.

Built to run **unattended on a schedule** (including in a cloud worker). It must be a quiet no-op when there is nothing to do, and it must never lose work: individual Dependabot PRs are closed **only after** the rollup PR's CI is fully green.

ARGUMENTS: $ARGUMENTS — an optional base branch. If omitted, use `dev` when it exists on `origin`, otherwise the repository's default branch (`gh repo view --json defaultBranchRef`).

## Guardrails (read first)

- **Security-only.** Include a Dependabot PR only if at least one package it bumps has an **open Dependabot security alert**. Routine (non-security) version-bump PRs are left untouched.
- **No major bumps — ever.** Exclude any PR whose targeted package crosses a **semver-major** boundary (e.g. `uuid 11 → 14`). This includes multi-package bundles where *any* bundled package is a major bump — if a bundle can't be split cleanly, defer the whole bundle. Majors are handled separately, one-to-one, by a human.
- **Never lose work.** Closing/deleting the individual Dependabot PRs happens **only after** CI on the rollup PR is green.
- **Quiet when idle.** If nothing is in scope, log the classification summary and stop — no branch, no PR, no notification.
- **Notify once, at the end.** Ping the human to review exactly once, only when the rollup PR is open, CI is fully green, and the superseded PRs are closed.

## Procedure

### 1. Resolve base branch & preflight

```bash
gh auth status
git fetch origin --prune
# BASE = $ARGUMENTS if set; else 'dev' if `git rev-parse --verify origin/dev` succeeds; else default branch
git switch "$BASE" && git pull --ff-only origin "$BASE"
```

If the working tree is dirty or you can't safely land on `$BASE`, stop and report — do not stash or force.

### 2. Discover & classify

```bash
# Open Dependabot PRs
gh pr list --state open --app dependabot --json number,title,headRefName,url --limit 100

# Packages with an open security alert
gh api repos/:owner/:repo/dependabot/alerts --paginate \
  --jq '.[] | select(.state=="open") | .dependency.package.name' | sort -u
```

If the alerts API returns **403 / permission denied** (the token may lack `security_events` scope — common in unattended/cloud runs), **stop and report that limitation**. Do not guess which PRs are security.

For each open Dependabot PR, parse the package(s) and `from → to` versions from the title (use `gh pr view <n>` for multi-package bundles), then classify:

- **INCLUDE** — has an open security alert **and** no major bump.
- **DEFER-MAJOR** — security but crosses a major (or a bundle containing any major). Reported, never merged.
- **SKIP-NONSECURITY** — no open alert. Left alone.

If **INCLUDE is empty**: print the classification summary and **stop** (quiet no-op). Still surface any DEFER-MAJOR items as a lightweight note so a human can action them, but this is not the "review the PR" ping.

### 3. Reuse or create the rollup branch/PR (idempotent)

A previous run may have left an open rollup PR:

```bash
gh pr list --state open --base "$BASE" --json number,headRefName,url \
  | grep chore/dependabot-security-rollup
```

- If one exists, check it out, rebase onto latest `$BASE`, and **update** it — do not open a second.
- Otherwise: `git switch -c chore/dependabot-security-rollup-$(date +%Y-%m-%d)`.

### 4. Apply the bumps

Capture exactly what Dependabot resolved (covers direct **and** transitive deps) by merging each INCLUDE branch, then reconcile deterministically:

```bash
for BRANCH in <each INCLUDE headRefName>; do
  git merge --no-edit "origin/$BRANCH" || {
    # Lockfile conflicts are expected when several PRs touch the same lockfile.
    # Resolve by keeping their manifest changes and regenerating the lock.
    git checkout --theirs <lockfile> 2>/dev/null || true
    git add -A && git commit --no-edit
  }
done
```

Then reconcile the dependency tree with the ecosystem's install command (`npm install`, `pnpm install`, `yarn`, etc.). For **non-lockfile ecosystems** (NuGet `.csproj`, Go modules, etc.), apply the version bump to the manifest directly instead of merging — again only if non-major.

Sanity-check locally with the repo's fast checks (e.g. `npm run compile` / `npm run build`, `dotnet build`) — **not** the full test suite; CI owns verification. If a bump breaks the build, fix it here. If one package is irreconcilable, drop just that package from the rollup and report it rather than blocking the whole batch.

### 5. Commit & push

```bash
git add -A
git commit -m "chore(deps): roll up Dependabot security updates"   # if merges left staged changes
git push -u origin HEAD
```

### 6. Open (or update) the rollup PR

```bash
gh pr create --base "$BASE" --title "chore(deps): security rollup ($(date +%Y-%m-%d))" --body "<body>"
# or: gh pr edit <n> --body "<regenerated body>"
```

Body lists, per included package: name, `from → to`, highest open advisory severity; a **Deferred (major — handle separately)** section with each DEFER-MAJOR PR number + link; and a **Supersedes** line referencing every INCLUDE PR number.

### 7. Drive to green CI with /goal — THE LOOP

`/goal` is a native Claude Code command — `/goal [condition|clear]` — that makes Claude keep working **across turns** until the condition holds. Set it to the full definition of done (substitute the rollup PR number):

```
/goal rollup PR #<ROLLUP> targets <BASE>, all its CI checks are green, and every superseded Dependabot PR is closed with its branch deleted
```

Then work the loop until the goal is met:

- Poll `gh pr checks <ROLLUP> --watch` (blocks until checks settle) rather than busy-waiting.
- On any failure: `gh run view --job <id> --log-failed`, fix the root cause in code, commit, push, re-poll. Treat a CI failure as a real regression to fix — never hand a red PR to the human.
- **Only once CI is fully green**, close each superseded Dependabot PR and delete its branch (part of meeting the goal):

```bash
gh pr close <n> --comment "Superseded by #<ROLLUP> — rolled into the security rollup." --delete-branch
gh pr view <n> --json state    # verify closed
```

The goal is not met — and you must not notify the human — until CI is green **and** every superseded PR is closed. Use `/goal clear` if you abort.

### 8. Notify — only now

Emit a single REVIEW-NEEDED summary: the rollup PR link, the count + names of included security fixes, the list of closed/superseded PRs, and the DEFER-MAJOR list with the reminder that majors are handled separately on a one-to-one basis.

## Success criteria

- ✅ One `chore/dependabot-security-rollup-*` PR open against `$BASE` with all in-scope security bumps.
- ✅ All CI checks on that PR green.
- ✅ Every superseded individual Dependabot PR closed with its branch deleted.
- ✅ Zero major bumps merged; all majors reported for separate handling.
- ✅ Human notified exactly once — or a quiet no-op if nothing was in scope.
