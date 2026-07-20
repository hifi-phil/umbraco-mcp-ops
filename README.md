# umbraco-mcp-ops

Cross-repo operations tooling for the Umbraco MCP repositories. Scripts here
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
  cloud-skill-sync/        # cloud-env setup script: load these skills into cloud routines
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
| [`cloud-skill-sync`](scripts/cloud-skill-sync/) | Cloud-environment **setup script**: clones this (public) repo and copies the ops skills into the session skills dir, so cloud routines can invoke them. See [Running skills in cloud routines](#running-skills-in-cloud-routines). |

## Plugins (Claude Code marketplace)

> **New here?** Read [`docs/self-learning-system.md`](docs/self-learning-system.md) — the
> single setup & operations guide (the flywheel, the **label matrix** showing which
> labels go on which repos, GitHub-App permissions, and how to drive each loop).

Install from this repo inside Claude Code:

```
/plugin marketplace add hifi-phil/umbraco-mcp-ops
/plugin install mcp-issue-loop@umbraco-mcp-ops
/plugin install merge-flow@umbraco-mcp-ops
/plugin install release-flow@umbraco-mcp-ops
/plugin install github-ops@umbraco-mcp-ops
/plugin install dependabot-rollup@umbraco-mcp-ops
/reload-plugins
```

| Plugin | What it does |
|--------|--------------|
| [`mcp-issue-loop`](plugins/mcp-issue-loop/) | Works the open `ready-for-ai` issues in an Umbraco MCP repo — one worktree + subagent per issue (max 3 parallel), each driven to a CI-green PR following the established MCP skills, then iterated against review feedback until you approve and it merges. Also ships the **self-learning loop**: capture hooks file `proto-learning` issues here, and the `triage-learnings` skill (Loop B) periodically routes each one to the repo that owns it — a tracked issue on the specific MCP repo it affects (domain-specific learnings only), a gated PR to the shared `umbraco-mcp-skills` (`Umbraco-MCP-Base`) for generalizable ones, or a `loop-improvement` issue here for the loop itself. Loop B files issues to owning repos and only drafts PRs for the shared tooling. Also ships **`content-issue-loop`** — the lightweight sibling of the MCP loop that works `ready-for-ai` issues on repos *without* the Umbraco toolchain (this ops repo, `Umbraco-MCP-Base`, docs/plugins), doing skill/plugin/script/markdown edits; it's the converter for the `loop-improvement` issues triage files here. Repo-agnostic; runs locally or as a scheduled cloud routine. |
| [`release-flow`](plugins/release-flow/) | Branching, merge, release, and dev-sync workflow skills for any repo — detects gitflow (`dev` + `main`) vs main-only and follows the matching conventions for branch naming, squash vs merge-commit, cutting a release, tagging, and syncing back to `dev`. Bundles `release-and-branching`, `sync-dev`, and **`auto-release-loop`** — an issue+label-triggered, CI-gated release loop: label an issue titled `release <version>` with `auto-release`, and it cuts the branch, bumps + changelogs, drives CI green, then (CI is the gate — no approval pause) merges, tags, publishes the GitHub Release, and syncs `main`→`dev`, with Claude push notifications at start + completion. Uses `/goal`. |
| [`merge-flow`](plugins/merge-flow/) | Guardrail loop that merges PRs labelled `auto-merge` — but only once they're approved, CI-green (polled, never `--auto`), conflict-free, and on the right base. Replaces error-prone manual merges; drives each to a clean merge (branch deleted) or flags the blocker. Uses `/goal`. Repo-agnostic; local or scheduled cloud routine. |
| [`github-ops`](plugins/github-ops/) | Shared reference the other loops point at for GitHub work in **both** environments — `gh` CLI + `git` locally, the **GitHub MCP server** (`mcp__github__*`) on Claude web / in routines. One operation catalog, two reference files; keeps the dual path in one place instead of duplicated across skills. |
| [`dependabot-rollup`](plugins/dependabot-rollup/) | Roll every open Dependabot **security** PR (excluding semver-major bumps) into one branch + PR, drive it to green CI, and close the superseded individual PRs. Repo-agnostic; safe to run unattended (weekly routine). |

> **Note:** `mcp-issue-loop` drives local worktrees, builds, and integration tests,
> so it runs on a developer machine (or a runner with the full .NET/Umbraco
> toolchain), not the lightweight web runners the `scripts/` routines target.

### Running skills in cloud routines

`/plugin install` (above) is for **local** Claude Code. A **cloud routine** doesn't read
your machine's plugins — it loads skills from the session's skills dir. To get these
skills there without committing them into every target repo or uploading them by hand,
use the [`cloud-skill-sync`](scripts/cloud-skill-sync/) **environment setup script**:

1. Open the cloud environment your routine uses (Claude Code on the web → environment
   settings) and paste [`scripts/cloud-skill-sync/cloud-skill-sync.sh`](scripts/cloud-skill-sync/cloud-skill-sync.sh)
   into its **Setup script** field.
2. On the next build it clones this (public) repo and copies the listed skills into
   `$HOME/.claude/skills`; routines in that environment can then invoke them.

No per-repo marketplace marker, no token, no manual upload — the public clone is
anonymous, so the runner's egress proxy stays free for the routine's own GitHub work.
`github-ops` is the shared dependency every loop references by name, so keep it in the
script's `SKILLS` list. After changing a skill, bump `VERSION` in the script to force a
re-clone (the env snapshot is otherwise cached ~7 days). See
[`docs/self-learning-system.md`](docs/self-learning-system.md) for the full setup.
