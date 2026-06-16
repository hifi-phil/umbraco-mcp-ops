#!/usr/bin/env bash
# Shared Slack helper for umbraco-mcp-ops scripts.
# Posts to the channel bound to the incoming webhook in $SLACK_WEBHOOK_URL.
# If the variable is unset, it logs a warning and is a no-op (so dry runs work offline).

post_to_slack() {
  local text="$1"
  if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then
    echo "WARN: SLACK_WEBHOOK_URL not set — printing message instead of posting:" >&2
    echo "----------------------------------------" >&2
    echo "$text" >&2
    echo "----------------------------------------" >&2
    return 0
  fi
  curl -sS -X POST -H 'Content-type: application/json' \
    --data "$(jq -n --arg t "$text" '{text: $t}')" \
    "$SLACK_WEBHOOK_URL" >/dev/null
}
