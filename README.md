# umbraco-mcp-ops

Cross-repo operations tooling for the Umbraco MCP repositories. The workflows here
act on *several* repos rather than belonging to any one product, so they live in
their own home and are run on a schedule (Claude routines) or by hand.

This repo is a **Claude Code plugin marketplace** — the workflows that drive the MCP
repos are distributed as installable plugins (see
[Plugins](#plugins-claude-code-marketplace)). The one remaining `scripts/` entry is
environment plumbing, not a GitHub workflow.

## Layout

```
.claude-plugin/
  marketplace.json         # marketplace manifest listing the plugins below
plugins/
  mcp-issue-loop/           # plugin: autonomous ready-for-ai issue loop
  branch-housekeeping/      # plugin: branch-state report (skill) + cleanup (command)
    commands/               #   /clean-branches — the deliberate, local-only cleanup
    scripts/                #   sweep.sh (read-only classify) + reap.sh (delete merged)
lib/                       # shared helpers (currently unused — the plugin scripts use
  slack.sh                 #   gh + the Slack connector, not a webhook)
scripts/
  cloud-skill-sync/        # cloud-env setup script: load these skills into cloud routines
```

Some plugins ship **deterministic shell scripts** under `plugins/<plugin>/scripts/` for the
parts of a loop that have one right answer (classifying a branch, deleting a ref, resolving a
default branch). They use `gh`, never a raw token, and are shellchecked in CI.

Each plugin gets its own folder under `plugins/<plugin>/` and is listed in
`.claude-plugin/marketplace.json`.

## Requirements & authentication

**Nothing to configure — no token, no PAT, no webhook secret.**

All GitHub work goes through the **`github-ops`** skill, which picks the mechanism per
environment: the `gh` CLI locally, and the **GitHub MCP server** (`mcp__github__*`) in
Claude web / scheduled routines, authenticated by the **Claude GitHub App installed on
the Umbraco org**. The plugin scripts under `plugins/*/scripts/` are on the local path —
they call `gh`, which carries your login, so there's still no token to configure.

> **Historical note:** the weekly branch sweep used to be a bash script calling
> `api.github.com` with `curl` and a `GH_TOKEN`, relying on the web runner's egress proxy
> to inject the real credential. **That did not work in scheduled routines.**
> `branch-housekeeping` now splits the work by what each environment can actually do: the
> **report** runs either side (a `gh` script locally, MCP tools in a routine), while the
> **`/clean-branches` command** is local-only because branch deletion has no MCP tool at all.
> Don't reintroduce the `curl`+token pattern — if something needs GitHub from a cloud routine
> it goes through the MCP server, and if the capability isn't there, it belongs on the local
> path rather than behind a token.

Which repos and permissions are reachable is a GitHub-App-installation decision made by
an **Umbraco org owner** — see [`docs/self-learning-system.md`](docs/self-learning-system.md)
for the scopes each loop needs.

`cloud-skill-sync` needs only `git` and `jq`, both present on the runners, and clones
this public repo anonymously.

## Scripts

| Script | What it does |
|--------|--------------|
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
/plugin install open-work-report@umbraco-mcp-ops
/plugin install branch-housekeeping@umbraco-mcp-ops
/reload-plugins
```

| Plugin | What it does |
|--------|--------------|
| [`mcp-issue-loop`](plugins/mcp-issue-loop/) | Works the open `ready-for-ai` issues in an Umbraco MCP repo — one worktree + subagent per issue (max 3 parallel), each driven to a CI-green PR following the established MCP skills, then iterated against review feedback until you approve and it merges. Also ships the **self-learning loop**: capture hooks file `proto-learning` issues here, and the `triage-learnings` skill (Loop B) periodically routes each one to the repo that owns it — a tracked issue on the specific MCP repo it affects (domain-specific learnings only), a gated PR to the shared `umbraco-mcp-skills` (`Umbraco-MCP-Base`) for generalizable ones, or a `loop-improvement` issue here for the loop itself. Loop B files issues to owning repos and only drafts PRs for the shared tooling. Also ships **`content-issue-loop`** — the lightweight sibling of the MCP loop that works `ready-for-ai` issues on repos *without* the Umbraco toolchain (this ops repo, `Umbraco-MCP-Base`, docs/plugins), doing skill/plugin/script/markdown edits; it's the converter for the `loop-improvement` issues triage files here. And **`issue-discuss-loop`** — the step *before* `ready-for-ai`: label an issue `ai-discuss` and it writes a stub issue properly, asks questions when it can't yet, or critiques a written issue antagonistically, one comment per fire (your reply fires the next round) until you both agree on the smallest change that solves the problem. Comments address the loop by default; start one with `//` to ask a colleague instead and it stays out. Discussion only — no code, no PR. Repo-agnostic; runs locally or as an event-fired cloud routine. |
| [`release-flow`](plugins/release-flow/) | Branching, merge, release, and dev-sync workflow skills for any repo — detects gitflow (`dev` + `main`) vs main-only and follows the matching conventions for branch naming, squash vs merge-commit, cutting a release, tagging, and syncing back to `dev`. Bundles `release-and-branching`, `sync-dev`, and **`auto-release-loop`** — an issue+label-triggered, CI-gated release loop: label an issue titled `release <version>` with `auto-release`, and it cuts the branch, bumps + changelogs, drives CI green, then (CI is the gate — no approval pause) merges, tags, publishes the GitHub Release, and syncs `main`→`dev`, with Claude push notifications at start + completion. Uses `/goal`. |
| [`merge-flow`](plugins/merge-flow/) | Guardrail loop that merges PRs labelled `auto-merge` — but only once they're approved, CI-green (polled, never `--auto`), conflict-free, and on the right base. Replaces error-prone manual merges; drives each to a clean merge (branch deleted) or flags the blocker. Uses `/goal`. Repo-agnostic; local or scheduled cloud routine. |
| [`github-ops`](plugins/github-ops/) | Shared reference the other loops point at for GitHub work in **both** environments — `gh` CLI + `git` locally, the **GitHub MCP server** (`mcp__github__*`) on Claude web / in routines. One operation catalog, two reference files; keeps the dual path in one place instead of duplicated across skills. |
| [`dependabot-rollup`](plugins/dependabot-rollup/) | Roll every open Dependabot **security** PR (excluding semver-major bumps) into one branch + PR, drive it to green CI, and close the superseded individual PRs. Repo-agnostic; safe to run unattended (weekly routine). |
| [`open-work-report`](plugins/open-work-report/) | Daily cross-repo digest of everything currently open, posted to Slack `#daily-issue-and-pr-overview`. **Scope comes from the routine's own context** — the repos attached to it — so the skill carries no repo list and stops rather than guessing if it can't resolve one. Separates Dependabot **security** updates (listed individually) from routine version bumps (counted), flags the PRs that are ready to merge, blocked on CI, or waiting on a human, calls out the automation labels so loop-owned work reads apart from human work, and marks anything untouched for 30 days as stale. **Report-only** — read scopes only, nothing is commented on, labelled, or merged. Requires `github-ops`. |
| [`branch-housekeeping`](plugins/branch-housekeeping/) | **Two halves, deliberately separate.** The **skill** reports the state of the remote branches across **every** configured MCP repo in one run and posts a digest to `#umbraco-mcp-housekeeping`, classifying each non-protected branch by its **GitHub PR state** — authoritative where git ancestry isn't, since these repos squash-merge — into safe-to-remove, **merged-but-reused-since** (looks disposable, isn't), closed unmerged, no PR, and open. It is **informational and read-only — never deletes**, so it needs no write scope and runs as a **scheduled cloud routine** as well as locally. The **`/clean-branches` command** is the separate, deliberate cleanup: a purely mechanical script with no model in the loop, re-verifying every branch against the API (protected lists, live default branch, live protection, `merged_at`, and that the tip still matches what the PR merged) before deleting. Run it only when you want branches gone. The **command** is local-only — the GitHub MCP server exposes no branch-delete tool, so cleanup can't be scheduled at all. Also flags any repo whose **"Automatically delete head branches"** setting is off, which is the durable fix that cleanup only works around. |

> **Note:** `mcp-issue-loop` drives local worktrees, builds, and integration tests,
> so it runs on a developer machine (or a runner with the full .NET/Umbraco
> toolchain), not the lightweight web runners the scheduled routines target.

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
