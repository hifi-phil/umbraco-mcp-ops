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

- [`gh`](https://cli.github.com/) — authenticated, with permission to delete branches on the target repos.
- `jq`, `curl`.
- `SLACK_WEBHOOK_URL` — a Slack incoming-webhook URL (optional; if unset, summaries print to stderr instead of posting).

## Tools

| Tool | What it does |
|------|--------------|
| [`branch-housekeeping`](scripts/branch-housekeeping/) | Weekly sweep: deletes branches whose PR was merged, keeps open-PR branches, and posts ambiguous branches to Slack for review. |
