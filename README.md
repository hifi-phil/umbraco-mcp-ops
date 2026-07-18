# umbraco-mcp-ops

Private cross-repo operations tooling for the Umbraco MCP repositories. Scripts here
act on *several* repos via the GitHub API rather than belonging to any one product, so
they live in their own home and are run on a schedule (Claude routines) or by hand.

This repo is also a **Claude Code plugin marketplace** — the interactive
workflows that drive the MCP repos are distributed as installable plugins
(see [Plugins](#plugins-claude-code-marketplace)).

## Layout

```
.claude-plugin/
  marketplace.json         # marketplace manifest listing the plugins below
plugins/
  mcp-issue-loop/           # plugin: autonomous ready-for-ai issue loop
lib/                       # shared helpers reused across scripts
  slack.sh                 #   post_to_slack() — posts to the $SLACK_WEBHOOK_URL channel
scripts/
  branch-housekeeping/     # weekly: delete merged branches, flag ambiguous ones on Slack
```

Each script tool gets its own folder under `scripts/<tool>/` and reuses `lib/`.
Each plugin gets its own folder under `plugins/<plugin>/` and is listed in
`.claude-plugin/marketplace.json`.

## Requirements

- `curl`, `jq` — both pre-installed on the Claude Code on the web runners these
  routines execute on.
- `GH_TOKEN` — a GitHub token with access to the target repos (metadata +
  pull-requests read to classify branches, contents write to delete them). The
  runner injects one automatically. The GitHub CLI (`gh`) is intentionally **not**
  required — it isn't installed on the runners, so the scripts call the GitHub
  REST API directly.
- `SLACK_WEBHOOK_URL` — a Slack incoming-webhook URL (optional; if unset, the
  summary is printed to stdout and a routine relays it to Slack instead).

## Authentication

These tools talk to repos in the **Umbraco org**, and you do **not** need a
personal access token (PAT) to run them.

They are designed to run inside **Claude Code on the web**. There, outbound
HTTPS goes through the runner's egress proxy, which authenticates calls to
`api.github.com` itself using the **Claude GitHub App installed on the Umbraco
org**. The `GH_TOKEN` environment variable the runner sets is only the literal
placeholder `proxy-injected` — the real credential is injected proxy-side, so
the `Authorization` header the scripts send is effectively ignored for GitHub.
(`GH_TOKEN` being non-empty is all the scripts check before starting.)

What this means in practice:

- **No PAT, no secret to configure.** Nothing to paste into environment
  variables. Branch deletion works because the org's GitHub App grants
  `contents: write` (plus `pull_requests: read` and `metadata: read`).
- **Run it on the web, not externally.** The only place a real token would be
  needed is running these scripts somewhere *without* that proxy — a laptop or a
  generic CI runner. Since the repos live in the Umbraco org (where individual
  PATs may not be available), run the routine inside Claude Code on the web,
  where auth is handled for you.
- Adjusting which repos/permissions are reachable is a GitHub-App-installation
  decision made by an **Umbraco org owner**, not a per-user token setting.

## Tools

| Tool | What it does |
|------|--------------|
| [`branch-housekeeping`](scripts/branch-housekeeping/) | Weekly sweep: deletes branches whose PR was merged, keeps open-PR branches, and posts ambiguous branches to Slack for review. |

## Plugins (Claude Code marketplace)

Install from this repo inside Claude Code:

```
/plugin marketplace add hifi-phil/umbraco-mcp-ops
/plugin install mcp-issue-loop@umbraco-mcp-ops
```

| Plugin | What it does |
|--------|--------------|
| [`mcp-issue-loop`](plugins/mcp-issue-loop/) | Works the open `ready-for-ai` issues in an Umbraco MCP repo — one worktree + subagent per issue (max 3 parallel), each driven to a CI-green PR following the established MCP skills, then iterated against review feedback until you approve and it merges. Also ships the **self-learning loop**: capture hooks file `proto-learning` issues here, and the `triage-learnings` skill (Loop B) periodically routes them into gated PRs against the right home (repo `CLAUDE.md` / project-local skill / shared `umbraco-mcp-skills`), or into `loop-improvement` issues here when the learning is about the loop itself. Repo-agnostic; runs locally or as a scheduled cloud routine. |
| [`release-flow`](plugins/release-flow/) | Branching, merge, release, and dev-sync workflow skills for any repo — detects gitflow (`dev` + `main`) vs main-only and follows the matching conventions for branch naming, squash vs merge-commit, cutting a release, tagging, and syncing back to `dev`. Bundles the `release-and-branching` and `sync-dev` skills. |

> **Note:** `mcp-issue-loop` drives local worktrees, builds, and integration tests,
> so it runs on a developer machine (or a runner with the full .NET/Umbraco
> toolchain), not the lightweight web runners the `scripts/` routines target.
