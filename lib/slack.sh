#!/usr/bin/env bash
# Shared Slack helper for umbraco-mcp-ops scripts.
# OPTIONAL extra delivery path: if $SLACK_WEBHOOK_URL is set, posts to its channel.
# Callers always print the summary to stdout themselves, so when no webhook is
# configured (e.g. a Claude routine relays stdout to Slack instead) this is a
# silent no-op.

post_to_slack() {
  local text="$1"
  [[ -z "${SLACK_WEBHOOK_URL:-}" ]] && return 0
  curl -sS -X POST -H 'Content-type: application/json' \
    --data "$(jq -n --arg t "$text" '{text: $t}')" \
    "$SLACK_WEBHOOK_URL" >/dev/null
}
