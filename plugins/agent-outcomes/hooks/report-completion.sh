#!/usr/bin/env bash
#
# PostToolUse hook: fires after every tool call in a loop's session. Detects
# when the call just posted an agent-outcomes artifact (a comment carrying
# an <!-- agent-outcome:<routine> --> marker + fenced JSON — see this
# plugin's SKILL.md) and forwards the raw JSON on a fast, non-authoritative
# path. See docs/agent-orchestration/11-outcome-artifact.md in
# umbraco-mcp-ops for why this is never the authoritative signal (the
# GitHub write is) and only ever a "cancel the watchdog early / update the
# dashboard sooner" hint — losing this call costs detail, never
# correctness.
#
# Deliberately does not validate the JSON's shape — that's
# graph/outcomes.ts's job (parseBuildOutcomeShape), the one place this
# system defines what counts as a valid outcome. Duplicating that check
# here in bash would recreate the two-copies-of-one-shape problem the
# graph/ refactor spent real effort eliminating. This forwards raw text;
# the receiving end decides if it's well-formed.
#
# Matches on marker presence anywhere in tool_input's string values, not on
# tool name — a comment can be posted via the Bash tool + gh CLI (local) or
# a GitHub MCP tool (cloud), and github-ops's whole reason for existing is
# that those two shapes differ. A marker is a marker in either one's raw
# text, so this doesn't need to know which path posted it.
#
# Env knobs:
#   AGENT_OUTCOMES_ENDPOINT   URL to POST {routine, outcome} to (curl).
#                             Unset -> log only, no network call — the safe
#                             default until a real endpoint exists.
#   AGENT_OUTCOMES_LOG        override the log file path
set -uo pipefail

LOG="${AGENT_OUTCOMES_LOG:-${HOME}/.cache/agent-outcomes/capture.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
log() { printf '%s %s\n' "$(date -u +%FT%TZ 2>/dev/null || echo now)" "$*" >>"$LOG" 2>/dev/null || true; }

command -v jq >/dev/null 2>&1 || { log "missing jq — skipping"; exit 0; }

EVENT="$(cat)"

# Every string value anywhere inside tool_input, marker-bearing one first —
# finds the artifact regardless of which field/tool carried it.
BLOB="$(printf '%s' "$EVENT" | jq -r '
  [(.tool_input // {}) | .. | strings | select(test("<!-- agent-outcome:"))] | first // empty
' 2>/dev/null)"

[ -n "$BLOB" ] || exit 0

MARKER_LINE="$(printf '%s\n' "$BLOB" | grep -o -m1 '<!-- agent-outcome:[a-zA-Z0-9_-]* -->')"
ROUTINE="$(printf '%s' "$MARKER_LINE" | sed -E 's/<!-- agent-outcome:([a-zA-Z0-9_-]*) -->/\1/')"
JSON="$(printf '%s\n' "$BLOB" | sed -n '/```json/,/```/p' | sed '1d;$d')"

if [ -z "$ROUTINE" ] || [ -z "$JSON" ] || ! printf '%s' "$JSON" | jq -e . >/dev/null 2>&1; then
  log "marker present but could not extract a well-formed routine+JSON pair — skipping"
  exit 0
fi

log "detected outcome artifact for routine=$ROUTINE: $(printf '%s' "$JSON" | jq -c .)"

if [ -z "${AGENT_OUTCOMES_ENDPOINT:-}" ]; then
  log "AGENT_OUTCOMES_ENDPOINT not set — logged only, no live target yet"
  exit 0
fi

command -v curl >/dev/null 2>&1 || { log "curl not available — cannot forward to $AGENT_OUTCOMES_ENDPOINT"; exit 0; }

BODY="$(jq -cn --arg routine "$ROUTINE" --argjson outcome "$JSON" '{routine:$routine, outcome:$outcome}' 2>/dev/null)"
if [ -z "$BODY" ]; then
  log "failed to assemble forward payload — skipping POST"
  exit 0
fi

curl -fsS -m 5 -X POST -H 'Content-Type: application/json' -d "$BODY" "$AGENT_OUTCOMES_ENDPOINT" \
  >>"$LOG" 2>&1 || log "POST to $AGENT_OUTCOMES_ENDPOINT failed"

exit 0
