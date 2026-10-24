#!/usr/bin/env bash
#
# Notification and SessionEnd hook: tells the agent-orchestration Worker
# a loop's session has stopped short, by its own signal to POST /routine-signal.
# The only signal a dead session sends: without it the Worker finds out when
# the watchdog expires, up to an hour later.
#
# - Notification, for a permission prompt (matcher: permission_prompt): the
#   session is waiting on an answer nobody will give.
#   {kind:"blocked", detail:"<tool>[: <the command's first word, if a plain name>]"}
# - SessionEnd: the session ended. (Not Stop: that fires whenever the main thread ends a turn,
#   e.g. to wait on a background subagent, with the run still going.)
#   {kind:"ended", detail:"<reason>"}
#   Only if this run delivered no outcome (post-outcome.sh leaves a state
#   file when its POST went out), and once per run.
#
# Which run this is comes from the session's own first prompt (signal-lib.sh,
# no fallback to another session's run); a session the Worker didn't fire sends nothing. The detail is quoted on GitHub,
# so it never carries more than the tool's name and a command's first word, never
# its arguments (a short credential, `-u user:pass`, is not caught by pattern redaction).
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
. "$(dirname "${BASH_SOURCE[0]}")/signal-lib.sh" || { log "signal-lib.sh missing — skipping"; exit 0; }

# The run is looked up first, endpoint or not: post-outcome.sh reads the cache this writes.
# Strict: blocked and ended change the run's state, so no last-run fallback.
CTX="$(run_context strict)"
[ -n "$CTX" ] || exit 0
[ -n "${AGENT_OUTCOMES_ENDPOINT:-}" ] || exit 0
ROUTINE="$(printf '%s' "$CTX" | awk '{print $1}')"
ISSUE="$(printf '%s' "$CTX" | awk '{print $4}')"
KEY="$(run_key "$CTX")"
mkdir -p "$STATE" 2>/dev/null || true

# one_line <max>: stdin squeezed to one line, cut to <max> characters.
one_line() { tr -s '[:space:]' ' ' | cut -c "1-$1" | sed -E 's/^ +| +$//g'; }

case "$(printf '%s' "$EVENT" | jq -r '.hook_event_name // empty' 2>/dev/null)" in
  Notification)
    # A permission prompt reads "Claude needs your permission to use <tool>";
    # the tool and a command's first word are all that goes out.
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
    # Only a plain command name as the first word (letters, digits, `._+/-`, up to 32); anything else
    # (an inline VAR=secret, a URL, a token, glued operators, `@`) is dropped, as is a non-string command.
    CMD="$(printf '%s' "$EVENT" | jq -r '(.tool_input // {}) | (.command // empty) | select(type == "string")' 2>/dev/null | one_line 200 | awk '{print $1}' | grep -E '^[A-Za-z0-9._+/-]{1,32}$')"
    DETAIL="${TOOL:-a tool}${CMD:+: $CMD}"
    SIGNAL="$(jq -cn --arg routine "$ROUTINE" --argjson issue "$ISSUE" --arg detail "$DETAIL" \
      '{kind:"blocked", routine:$routine, issue:$issue, detail:$detail}')"
    send "$SIGNAL" "blocked ($TOOL)" "$CTX"
    ;;
  SessionEnd)
    [ -f "$STATE/reported-$KEY" ] && exit 0
    [ -f "$STATE/ended-$KEY" ] && exit 0
    REASON="$(printf '%s' "$EVENT" | jq -r '.reason // empty' 2>/dev/null | one_line 80)"
    DETAIL="the session ended${REASON:+ ($REASON)} without reporting an outcome"
    SIGNAL="$(jq -cn --arg routine "$ROUTINE" --argjson issue "$ISSUE" --arg detail "$DETAIL" \
      '{kind:"ended", routine:$routine, issue:$issue, detail:$detail}')"
    # The once-per-run marker only once it went out: a failed send leaves a later attempt free to retry.
    send "$SIGNAL" "ended" "$CTX" && { : >"$STATE/ended-$KEY" 2>/dev/null || true; }
    ;;
  *) log "unhandled hook event: $(printf '%s' "$EVENT" | head -c 200)" ;;
esac
exit 0
