# The throwaway worktree — create and tear down

Detail for **step 3** (create) and **step 9** (remove).

All branch work happens in a worktree so that **the invoking checkout is never touched** —
no `switch`, `checkout <branch>`, stash, reset or pull in it. It may hold uncommitted work,
a running dev server, or environment files. That also means a dirty checkout is **not** a
reason to abort the run.

## Create (idempotent) — step 3

The branch is `chore/dependabot-security-rollup-<date>` cut from `origin/dev`, or the
existing rollup branch step 1 found.

**Use the repo's own worktree process — do not invent one here.** Worktrees are
standardised across these repos, and the repo is the authority on how one is created: read
its `CLAUDE.md` worktree section and use the mechanism it documents (typically the
**`EnterWorktree`** tool, whose `WorktreeCreate` hook copies the files listed in
`.worktreeinclude`, provisions the worktree's database, rewrites ports, and runs the
install), or a repo-provided worktree skill if it has one. Following that process is what
keeps the worktree consistent with every other worktree in the repo — and its hook-run
install is work the rollup needs anyway.

Only if the repo documents **no** worktree process, fall back to plain `git worktree add`
at a path the repo already gitignores — try `.claude/worktrees` then `.worktrees` via
`git check-ignore -q`, and if neither is ignored, stop and ask for one to be added to
`.gitignore`. Never place the worktree at an un-ignored in-repo path (it pollutes
`git status`) or outside the repo (a local routine only has access to its one selected
folder).

Clear a stale worktree from a crashed run first — via the repo's removal process below,
never a blind delete.

When reusing an existing rollup branch, rebase it onto latest `origin/dev` inside the
worktree before merging anything new.

Call the resulting path `$WT`. Every remaining step runs inside it.

## Tear down — step 9, every exit path

Whenever a worktree was created, remove it — on success, on `NEEDS-ME`, and on any error
or early stop from step 3 onwards.

**Use the repo's own worktree removal process**, matching however it was created: the
`ExitWorktree` tool with the remove action, or the repo's own cleanup skill (e.g.
`/cleanup`) where it documents one. This matters more than creation did — in these repos
teardown is destructive and repo-specific: the `WorktreeRemove` hook kills every process
still holding files in the worktree (demo-site binaries re-parented to launchd included)
and drops the worktree's database. A bare `git worktree remove` leaves both behind, so the
directory won't free and the database leaks.

Only if the repo documents no removal process, fall back to:

```bash
cd "$REPO"
git worktree remove --force "$WT"
git worktree prune
```

Either way: only ever remove the `dependabot-rollup` worktree this run created; never
another worktree in the repo. The branch stays on `origin`, so nothing is lost — only the
local worktree goes, and the next run reuses the branch via step 3.
