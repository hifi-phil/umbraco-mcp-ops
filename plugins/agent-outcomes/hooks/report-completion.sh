#!/usr/bin/env bash
#
# PostToolUse hook: fires after every tool call in a loop's session, and
# tells the agent-orchestration Worker the session is alive: a heartbeat to the
# Worker's POST /routine-signal (worker/src/index.ts in umbraco-mcp-ops), at
# most once per AGENT_OUTCOMES_HEARTBEAT_SECS. It names the step (e.g. "Bash:
# Run the tests"), which pushes the watchdog's deadline back and is what an
# expiry quotes, so ai-stuck says what the run was last doing.
#
# Heartbeats only. An outcome is reported through
# skills/agent-outcomes/scripts/post-outcome.sh and nothing else: this hook
# infers nothing from what a tool call's text happens to contain
# (docs/agent-orchestration/11-outcome-artifact.md).
#
# Which run this is, and how a signal is sent: signal-lib.sh.
#
# Env knobs:
#   AGENT_OUTCOMES_ENDPOINT        the Worker's .../routine-signal URL. Unset ->
#                                  send nothing.
#   AGENT_OUTCOMES_TOKEN           its bearer secret (tofu output
#                                  routine_signal_secret).
#   AGENT_OUTCOMES_HEARTBEAT_SECS  minimum gap between heartbeats (default 60).
#   AGENT_OUTCOMES_STATE           where the run cache lives (default
#                                  ~/.cache/agent-outcomes).
#   AGENT_OUTCOMES_LOG             override the log file path
set -uo pipefail

STATE="${AGENT_OUTCOMES_STATE:-${HOME}/.cache/agent-outcomes}"
LOG="${AGENT_OUTCOMES_LOG:-${STATE}/capture.log}"
HEARTBEAT_SECS="${AGENT_OUTCOMES_HEARTBEAT_SECS:-60}"
log() {
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  printf '%s %s\n' "$(date -u +%FT%TZ 2>/dev/null || echo now)" "$*" >>"$LOG" 2>/dev/null || true
}

command -v jq >/dev/null 2>&1 || { log "missing jq — skipping"; exit 0; }

EVENT="$(cat)"

. "$(dirname "${BASH_SOURCE[0]}")/signal-lib.sh" || { log "signal-lib.sh missing — skipping"; exit 0; }

# --- A heartbeat -------------------------------------------------------------
# The run is looked up first, endpoint or not: post-outcome.sh reads the cache this writes.
# Then the cheap exits: no endpoint, or a heartbeat sent too recently.
CTX="$(run_context)"
[ -n "$CTX" ] || exit 0
[ -n "${AGENT_OUTCOMES_ENDPOINT:-}" ] || exit 0

BEAT="$STATE/beat-$(printf '%s' "$CTX" | tr -c 'A-Za-z0-9_-' '_')"
NOW="$(date +%s)"
if [ -f "$BEAT" ] && [ $((NOW - $(cat "$BEAT" 2>/dev/null || echo 0))) -lt "$HEARTBEAT_SECS" ]; then
  exit 0
fi
mkdir -p "$STATE" 2>/dev/null || true
printf '%s' "$NOW" >"$BEAT" 2>/dev/null || true

# The step: the tool, plus the call's own short description or skill name.
# Never its command, prompt or paths: an expiry quotes the step in a GitHub
# comment, and a command can carry a token.
STEP="$(printf '%s' "$EVENT" | jq -r '
  (.tool_name // "tool") as $t
  | (.tool_input // {}) as $i
  | ($i.description // $i.skill // "") as $d
  | ($d | tostring | gsub("\\s+"; " ") | .[0:80]) as $d
  | if $d == "" then $t else "\($t): \($d)" end
' 2>/dev/null)"
SIGNAL="$(jq -cn --arg routine "$(printf '%s' "$CTX" | awk '{print $1}')" \
  --argjson issue "$(printf '%s' "$CTX" | awk '{print $4}')" --arg step "${STEP:-tool}" \
  '{kind:"process", routine:$routine, issue:$issue, step:$step}')"
send "$SIGNAL" "heartbeat ($STEP)" "$CTX"
exit 0
