#!/usr/bin/env bash
#
# Notification, Stop and SessionEnd hook: tells the agent-orchestration Worker
# a loop's session has stopped short, by its own signal to POST /routine-signal.
# The only signal a dead session sends: without it the Worker finds out when
# the watchdog expires, up to an hour later.
#
# - Notification, for a permission prompt (matcher: permission_prompt): the
#   session is waiting on an answer nobody will give.
#   {kind:"blocked", detail:"<tool> <first 120 chars of what it asked>"}
# - Stop / SessionEnd: the session stopped.
#   {kind:"ended", detail:"<reason>"}
#   Only if this session reported no outcome (post-outcome.sh leaves a state
#   file when it does), and once per run: the second of Stop and SessionEnd,
#   or a Stop per turn, sends nothing.
#
# Which run this is comes from the session's first prompt (signal-lib.sh); a
# session the Worker didn't fire sends nothing. The detail is quoted on GitHub,
# so it is cut short and never carries more than the tool's name and the
# start of what it asked.
#
# Env: AGENT_OUTCOMES_ENDPOINT / _TOKEN / _STATE / _LOG, as report-completion.sh.
set -uo pipefail

STATE="${AGENT_OUTCOMES_STATE:-${HOME}/.cache/agent-outcomes}"
LOG="${AGENT_OUTCOMES_LOG:-${STATE}/capture.log}"
log() {
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  printf '%s %s\n' "$(date -u +%FT%TZ 2>/dev/null || echo now)" "$*" >>"$LOG" 2>/dev/null || true
}

command -v jq >/dev/null 2>&1 || { log "missing jq — skipping"; exit 0; }

EVENT="$(cat)"
. "$(dirname "${BASH_SOURCE[0]}")/signal-lib.sh"

[ -n "${AGENT_OUTCOMES_ENDPOINT:-}" ] || exit 0
CTX="$(run_context)"
[ -n "$CTX" ] || exit 0
ROUTINE="$(printf '%s' "$CTX" | awk '{print $1}')"
ISSUE="$(printf '%s' "$CTX" | awk '{print $4}')"
KEY="$(run_key "$CTX")"
mkdir -p "$STATE" 2>/dev/null || true

# one_line <max>: stdin squeezed to one line, cut to <max> characters.
one_line() { tr -s '[:space:]' ' ' | cut -c "1-$1" | sed -E 's/^ +| +$//g'; }

case "$(printf '%s' "$EVENT" | jq -r '.hook_event_name // empty' 2>/dev/null)" in
  Notification)
    # A permission prompt reads "Claude needs your permission to use <tool>";
    # the tool and the start of its command are all that goes out.
    NTYPE="$(printf '%s' "$EVENT" | jq -r '.notification_type // empty' 2>/dev/null)"
    MSG="$(printf '%s' "$EVENT" | jq -r '.message // empty' 2>/dev/null)"
    case "$NTYPE" in
      permission_prompt) ;;
      "") printf '%s' "$MSG" | grep -qi 'permission' || exit 0 ;;
      *) exit 0 ;;
    esac
    TOOL="$(printf '%s' "$EVENT" | jq -r '.tool_name // empty' 2>/dev/null)"
    if [ -z "$TOOL" ]; then
      TOOL="$(printf '%s' "$MSG" | sed -nE 's/.*permission to (use|run) ([^ ]+).*/\2/p' | head -n1)"
    fi
    CMD="$(printf '%s' "$EVENT" | jq -r '(.tool_input // {}) | (.command // .file_path // .path // .url // .description // empty) | tostring' 2>/dev/null | one_line 120)"
    DETAIL="$(printf '%s %s' "${TOOL:-a tool}" "$CMD" | one_line 140)"
    SIGNAL="$(jq -cn --arg routine "$ROUTINE" --argjson issue "$ISSUE" --arg detail "$DETAIL" \
      '{kind:"blocked", routine:$routine, issue:$issue, detail:$detail}')"
    send "$SIGNAL" "blocked ($TOOL)" "$CTX"
    ;;
  Stop|SessionEnd)
    [ -f "$STATE/reported-$KEY" ] && exit 0
    [ -f "$STATE/ended-$KEY" ] && exit 0
    REASON="$(printf '%s' "$EVENT" | jq -r '.reason // empty' 2>/dev/null | one_line 80)"
    case "$(printf '%s' "$EVENT" | jq -r '.hook_event_name' 2>/dev/null)" in
      Stop) DETAIL="the session stopped without reporting an outcome" ;;
      *) DETAIL="the session ended${REASON:+ ($REASON)} without reporting an outcome" ;;
    esac
    : >"$STATE/ended-$KEY" 2>/dev/null || true
    SIGNAL="$(jq -cn --arg routine "$ROUTINE" --argjson issue "$ISSUE" --arg detail "$DETAIL" \
      '{kind:"ended", routine:$routine, issue:$issue, detail:$detail}')"
    send "$SIGNAL" "ended" "$CTX"
    ;;
esac
exit 0
