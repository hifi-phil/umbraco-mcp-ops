# Running the report on a schedule

## Local only — and why that's now a small constraint

`sweep.sh` uses `gh`, so the report runs where `gh` does: a dev machine.

The deeper reason is the cleanup half, which cannot exist on the cloud path at all. The
**GitHub MCP server exposes no branch- or ref-delete tool** — the `repos` toolset has
`create_branch` but no delete, the `git` toolset is a single tool (`get_repository_tree`), and
`merge_pull_request` has no delete-branch parameter. Verified against the server's own tool
registration list
([`pkg/github/tools.go`](https://github.com/github/github-mcp-server/blob/main/pkg/github/tools.go)).
That's why `/clean-branches` is local, and the report stayed alongside it.

The report itself needs only reads, so it *could* be rebuilt on the MCP path if you ever want
it as a cloud routine. That would mean maintaining a second implementation of the
classification — including the reuse check — so it's not worth doing until you actually want a
cloud report.

An earlier version tried a third route: a bash script calling `api.github.com` with `curl` and
a `GH_TOKEN`, trusting the web runner's egress proxy to inject the credential. **It did not
work in scheduled routines.** Don't reintroduce it.

## No consent line needed

The report writes nothing, so there is nothing for a destructive-action classifier to block
and no authorisation to arrange. A bare `/branch-housekeeping` prompt is complete.

This is the main practical gain from splitting report and cleanup: the scheduled half is
consequence-free, so it can run unattended without anyone having to reason about permissions.
`/clean-branches` carries the risk, and you invoke it yourself.

## No `/goal` needed

`/goal` keeps Claude working across turns until a condition holds. `dependabot-rollup` can't
survive an unattended run without one, because a rollup spans installs, a CI wait, and fix
rounds.

This is one script invocation and one Slack post — normally a single turn. A routine prompt
without a goal completes fine. Don't add one; a goal left set makes the next run inherit a
stale objective.

## One routine covers every repo

Unlike `dependabot-rollup`, which needs one routine per repo because it needs a **working
tree** per repo, this needs no working tree — it's pure API. `repos.conf` carries the scope,
so **a single routine reports on every repo in one digest.**

Point it at any local checkout (the ops repo is natural, since that's where the scripts live).
The folder only decides which `CLAUDE.md`, settings, and permissions apply — it is *not* the
repo being swept.

## Routine prompt

```text
/branch-housekeeping

Report only. Sweep every repo in the skill's repos.conf, then post the digest to the Slack channel it names, relayed verbatim. Do not delete any branch and do not run reap.sh — if the digest shows branches worth removing, name the /clean-branches command and stop.
```

## Cadence

Weekly. It isn't event-driven, so it doesn't go through `loop-dispatch`, and it needs your
machine awake at the scheduled time. A missed week is harmless — nothing degrades — so don't
add a catch-up mechanism.
