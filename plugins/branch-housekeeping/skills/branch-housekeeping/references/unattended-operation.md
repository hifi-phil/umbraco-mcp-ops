# Unattended operation — local-only, consent, and `/goal`

Everything here is about making the weekly run work on a schedule without a human watching.
Read it before setting up (or debugging) a routine.

## Local only — a cloud routine cannot do this

The deletes are `gh api -X DELETE repos/<repo>/git/refs/heads/<branch>`. Cloud routines have
no `gh`, and the **GitHub MCP server exposes no branch- or ref-delete tool** — its `repos`
toolset has `create_branch` but no delete, its `git` toolset is a single tool
(`get_repository_tree`), and `merge_pull_request` has no delete-branch parameter. Verified
against the server's own tool registration list
([`pkg/github/tools.go`](https://github.com/github/github-mcp-server/blob/main/pkg/github/tools.go)).

So this is local-only for the same structural reason `dependabot-rollup` is: the capability
simply isn't on the cloud path. Run it on a dev machine (e.g. a Desktop scheduled task).

An earlier version of this skill tried a third route — a bash script calling
`api.github.com` with `curl` and a `GH_TOKEN`, trusting the web runner's egress proxy to
inject the credential. **It did not work in routines.** Don't reintroduce it; `gh` locally is
the supported path.

## Unattended consent — the routine prompt must authorise the deletes

The run ends by deleting remote branches. In auto/bypass mode that is judged by a classifier
reading **the task prompt**, not this skill — so a bare `/branch-housekeeping` prompt gets the
deletes denied as `[Git Destructive]`, and the run silently degrades to report-only. Put the
consent in the routine prompt itself:

```text
/branch-housekeeping

You are authorised to delete the remote branches the sweep classifies as MERGED — their work
is already in mainline and every one is recoverable from its merged PR. Do not delete anything
in any other category, and do not edit repos.conf.
```

That is the only thing the routine prompt needs beyond the command.

**No consent line → report-only, and say so in the digest.** This is deliberate: it makes the
same skill safe to run by hand or from an unauthorised prompt, and it means a misconfigured
routine under-acts rather than over-acts. Never treat the presence of merged branches as
consent.

## `/goal` — not needed for the sweep, useful for a big reap

`/goal` is a native Claude Code command — `/goal [condition|clear]` — that makes Claude keep
working **across turns** until the condition holds. `dependabot-rollup` cannot survive an
unattended run without it, because a rollup spans installs, a CI wait, and fix rounds.

This skill is different: two script invocations and one Slack post, normally inside a single
turn. So `/goal` is **optional** here, and a routine prompt without one still completes.

Set one when a reap is large enough to risk a turn boundary (the first run after enabling the
repo setting had 50+ branches to clear):

```
/goal every MERGED branch from this sweep is deleted or explicitly skipped with a reason, and the digest is posted to #umbraco-mcp-housekeeping
```

`/goal clear` on every terminal outcome, including a report-only run — a goal left set makes
the next run inherit a stale objective.

## One routine covers every repo

Unlike `dependabot-rollup`, which needs one routine per repo because it needs a **working
tree** per repo (merges, lockfiles, installs), this sweep needs no working tree at all — it's
pure API. `repos.conf` carries the scope, so **a single routine sweeps every repo and posts
one digest.**

Point it at any local checkout (the ops repo is the natural choice, since that's where the
scripts live). The folder only decides which `CLAUDE.md`, settings, and permissions apply — it
is *not* the repo being swept.

## Scheduling

Weekly is right. This isn't event-driven, so it doesn't go through `loop-dispatch`, and it
needs your machine awake at the scheduled time. A missed week is harmless — unlike a security
rollup, nothing degrades — so don't add a catch-up mechanism.
