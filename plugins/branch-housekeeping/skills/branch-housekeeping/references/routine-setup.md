# Running the report on a schedule

The report is **informational and writes nothing**, so it runs in either environment — a
scheduled cloud routine or your dev machine. Schedule it wherever suits.

## Why the report can run in the cloud but the cleanup cannot

Only one operation is missing on the cloud path, and the report doesn't use it: the **GitHub MCP
server exposes no branch- or ref-delete tool.** Its `repos` toolset has `create_branch` but no
delete, its `git` toolset is a single tool (`get_repository_tree`), and `merge_pull_request` has
no delete-branch parameter — verified against the server's own tool registration list
([`pkg/github/tools.go`](https://github.com/github/github-mcp-server/blob/main/pkg/github/tools.go)).

Everything the report needs — repo metadata, branches, PRs — is a read the MCP server does
fine. So:

| | Cloud routine | Local |
|---|---|---|
| **the report** (this skill) | ✅ via `mcp__github__*` | ✅ via `sweep.sh` |
| **`/clean-branches`** | ❌ no delete tool exists | ✅ via `gh` |

That's the whole reason the two were split apart. Don't try to make `/clean-branches` work in a
routine; there is nothing to call.

An earlier version tried a third route — a bash script hitting `api.github.com` with `curl` and
a `GH_TOKEN`, trusting the web runner's egress proxy to inject the credential. **It did not work
in scheduled routines.** Don't reintroduce it.

## No consent line, no `/goal`

The report writes nothing, so there's no destructive action for a classifier to block and **no
authorisation to arrange** — unlike `dependabot-rollup`, whose routine prompt must name its
closes. A bare `/branch-housekeeping` prompt is complete.

`/goal` isn't needed either. It exists to carry Claude across turns until a condition holds,
which `dependabot-rollup` requires because a rollup spans installs, a CI wait and fix rounds.
This is a classification pass and one Slack post — normally a single turn. Don't set one; a goal
left set makes the next run inherit a stale objective.

Being consequence-free is the point of scheduling this half and not the other.

## One routine covers every repo

`repos.conf` carries the scope, so **a single routine reports on every repo in one digest.**
Unlike `dependabot-rollup`, which needs one routine per repo because it needs a **working tree**
per repo, this needs none — it's pure API.

## Cloud routine

The skill must be present in the environment: keep `branch-housekeeping` (and `github-ops`) in
the `SKILLS` list of
[`cloud-skill-sync`](../../../../scripts/cloud-skill-sync/cloud-skill-sync.sh), and bump that
script's `VERSION` after changing this skill so the env cache rebuilds.

**Two things deliberately don't reach the cloud env**, because that script copies only `skills/`
and `agents/`:

- **`commands/clean-branches.md`** — correct, and don't "fix" it. The command is local-only;
  delivering it to a routine would only offer something that cannot work there.
- **`scripts/repos.conf`** — it sits beside the scripts, not inside the skill. The cloud path
  therefore reads it out of the repo with *Get file contents*. If that read fails, the run must
  **stop rather than guess a scope** — see the skill's Step 1.

Add the Slack connector to the routine's `mcp_connections`. Prompt:

```text
You are running as a cloud worker; do all GitHub work via the GitHub MCP (github-ops). Run the branch-housekeeping skill over every repo in its repos.conf. It is informational and read-only — classify per the skill's classification.md, then post one digest to the Slack channel its sweep-config names, built exactly to the template in its report.md. Do not delete any branch: there is no branch-delete tool on this path, and cleanup is a separate local command. Follow the skill's guardrails verbatim and add no policy of your own.
```

## Local routine

Point it at any local checkout — the ops repo is natural, since that's where the scripts live.
The folder only decides which `CLAUDE.md`, settings and permissions apply; it is **not** the repo
being swept. Prompt:

```text
/branch-housekeeping

Report only. Sweep every repo in the skill's repos.conf, then post the digest to the Slack channel it names, relayed verbatim from sweep.sh. Do not delete any branch and do not run reap.sh — if the digest shows branches worth removing, name the /clean-branches command and stop.
```

Prefer local when you have the choice: `sweep.sh` is one deterministic invocation, so its output
is reproducible in a way a model-driven pass isn't.

## Cadence

Weekly. It isn't event-driven, so it doesn't go through `loop-dispatch`. A missed week is
harmless — nothing degrades — so don't add a catch-up mechanism. A local routine additionally
needs your machine awake at the scheduled time; that's the main reason to prefer the cloud one.
