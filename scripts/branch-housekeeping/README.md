# branch-housekeeping

Weekly remote-branch cleanup across the configured Umbraco MCP repos.

## What it does

For every non-protected branch in each configured repo, it looks up the branch's
**GitHub PR state** — the authoritative signal, because squash merges mean a merged
branch is *not* a git ancestor of `main`, so `git branch --merged` misses it — and acts:

| PR state | Action |
|----------|--------|
| `MERGED` | **Delete** the branch (its work is already in mainline). |
| `OPEN` | Keep, silently (active work, including dependabot). |
| `CLOSED` (unmerged) / no PR | Leave alone, list it on Slack for a human to decide. |

### Protected branches are never touched

A branch is protected — and skipped entirely — if it is any of:
- listed in `housekeeping.config` for that repo,
- the repo's **default** branch, or
- a branch with **GitHub branch protection** enabled.

This triple guard means a config typo can never delete `main`/`dev`.

## Usage

```bash
# Dry-run (default): report what WOULD happen, delete nothing.
./branch-housekeeping.sh

# Live: actually delete merged branches.
./branch-housekeeping.sh --live
```

The full summary is always printed to stdout. If `SLACK_WEBHOOK_URL` is set, it is
*also* posted to that webhook's channel — but the weekly routine instead relays the
printed summary to Slack via the Claude Slack integration, so no webhook is required.

## Adding a repo

Edit `housekeeping.config` and add a line:

```
"OWNER/REPO|main,dev,any,other,protected,branches"
```

## How the weekly routine uses it

A weekly Claude routine clones this repo, runs:

```bash
bash scripts/branch-housekeeping/branch-housekeeping.sh --live
```

and posts the printed summary to the `#umbraco-mcp-housekeeping` Slack channel via the
Claude Slack integration.
