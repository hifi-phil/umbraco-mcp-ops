# Unattended operation — `/goal`, consent, and why local-only

Everything in this file is about making the run survive an unattended schedule. Read it
before setting up (or debugging) a scheduled routine.

## Local only — never a cloud routine

The Claude GitHub App available to cloud routines has a fixed permission set with **no
Dependabot-alerts read** (it can't be granted), so a cloud run can never tell which PRs
are security PRs and can only no-op. Run this locally, where `gh` has the scope.

The same failure shows up mid-run as a permission error when listing alerts — see
[`classification.md`](classification.md).

## Run the whole thing under a `/goal`

`/goal` is a native Claude Code command — `/goal [condition|clear]` — that makes Claude
keep working **across turns** until the condition holds. **Without it this skill does not
survive an unattended run**: a rollup spans many turns (merges, installs, a CI wait, fix
rounds), and a routine whose prompt is just `/dependabot-rollup` has nothing else to carry
it past the first turn boundary.

Set the goal **as soon as step 2 finds work** — not at the CI loop, which is too late —
covering the entire definition of done:

```
/goal a Dependabot security rollup PR is open on <REPO> against dev, every targeted package verified at its expected resolved lockfile version, all CI checks green, every superseded Dependabot PR closed, the worktree torn down, and the outcome reported — the PR left unmerged
```

Fill in `<REPO>`, and add the PR number once step 7 has it. Then:

- **`/goal clear` on every terminal outcome** — `ROLLUP OPEN`, `NO-OP`,
  `ALREADY AWAITING REVIEW`, `NEEDS-ME`, or an abort. A goal left set makes the next run
  inherit a stale objective.
- Don't set a goal for a run that stops in step 1 or 2 (already-awaiting-review, or a
  quiet no-op) — there's nothing to persist.

## Unattended consent — the routine prompt must name the closes

The run ends by closing PRs the agent didn't open and deleting their branches. In
auto/bypass mode that's judged by a classifier reading **the task prompt**, not this skill
— so a bare `/dependabot-rollup` prompt gets the closes denied as `[Git Destructive]`. Put
the consent in the routine prompt itself:

```
/dependabot-rollup

You are authorised to close the superseded Dependabot PRs without merging, and delete
their branches, once the rollup PR's CI is fully green. The fix is in the rollup PR, and
if an advisory is still unresolved after it lands Dependabot raises the PR again.
```

That's the only thing the routine prompt needs beyond the command.

## One routine per repo

A local routine can only be given a single folder, and that folder also selects which
`CLAUDE.md`, project settings, and permissions apply. Point one routine at each repo you
want rolled up.
