# umbraco-mcp-ops

Private cross-repo operations tooling for the Umbraco MCP repositories. Scripts here
act on *several* repos via the GitHub API rather than belonging to any one product, so
they live in their own home and are run on a schedule (Claude routines) or by hand.

## Layout

```
lib/                       # shared helpers reused across tools
  slack.sh                 #   post_to_slack() — posts to the $SLACK_WEBHOOK_URL channel
scripts/
  branch-housekeeping/     # weekly: delete merged branches, flag ambiguous ones on Slack
```

Each tool gets its own folder under `scripts/<tool>/` and reuses `lib/`.

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

## Tools

| Tool | What it does |
|------|--------------|
| [`branch-housekeeping`](scripts/branch-housekeeping/) | Weekly sweep: deletes branches whose PR was merged, keeps open-PR branches, and posts ambiguous branches to Slack for review. |
