# Shared by the agent-outcomes hooks (sourced, not run). Expects the caller to
# have set EVENT (the hook's stdin JSON), STATE, LOG and `set -uo pipefail`.

# run_context: prints "routine owner repo number", or nothing. Which run this
# is comes from the session itself: the Worker's fire text, the routine's first
# prompt, carries `route=<routine> repo=<owner>/<repo> number=<n>`
# (routines-client.ts's dispatchText). Found once in the transcript and cached
# per session (from the first user entry only); the last run found is a fallback for a subagent's transcript,
# which may not carry the line (a routine container runs one fire). A session
# without one (an interactive session, say) never sends anything.
# `run_context strict` skips that last-run fallback: the signals that change
# the run's state (blocked, ended) must come from a session that knows its run,
# not from any other session in the container (a nested `claude -p`, say).
run_context() {
  local strict="${1:-}"
  local session transcript cache line
  session="$(printf '%s' "$EVENT" | jq -r '.session_id // "unknown"' 2>/dev/null)"
  cache="$STATE/run-$(printf '%s' "$session" | tr -c 'A-Za-z0-9_-' '_')"
  if [ -f "$cache" ]; then cat "$cache"; return; fi
  transcript="$(printf '%s' "$EVENT" | jq -r '.transcript_path // empty' 2>/dev/null)"
  line=""
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    # Only the session's first prompt: a later tool result that quotes a route line
    # (a nested analyzer reading the loop's transcript) isn't this session's run.
    line="$(jq -c 'select(.type == "user")' "$transcript" 2>/dev/null | head -n1 \
      | grep -o -m1 -E 'route=[a-z-]+ repo=[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+ number=[0-9]+' | head -n1)"
  fi
  if [ -n "$line" ]; then
    local routine owner repo number
    routine="$(printf '%s' "$line" | sed -E 's/route=([a-z-]+) .*/\1/')"
    owner="$(printf '%s' "$line" | sed -E 's/.* repo=([^/]+)\/.*/\1/')"
    repo="$(printf '%s' "$line" | sed -E 's/.* repo=[^/]+\/([^ ]+) .*/\1/')"
    number="$(printf '%s' "$line" | sed -E 's/.* number=([0-9]+).*/\1/')"
    mkdir -p "$STATE" 2>/dev/null || true
    printf '%s %s %s %s\n' "$routine" "$owner" "$repo" "$number" | tee "$cache" "$STATE/last-run" 2>/dev/null
    return
  fi
  # A transcript without the line: the last run this container saw, if recent.
  if [ "$strict" != strict ] && [ -f "$STATE/last-run" ] && [ -n "$(find "$STATE/last-run" -mmin -360 2>/dev/null)" ]; then
    cat "$STATE/last-run"
  fi
}

# run_key <ctx>: the run's name in state-file names.
run_key() { printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '_'; }

# send <signal-json> <what> <ctx>: POST {owner, repo, signal} to the Worker.
# Returns non-zero when it was not sent.
send() {
  local signal="$1" what="$2" ctx owner repo body
  ctx="$3"
  owner="$(printf '%s' "$ctx" | awk '{print $2}')"
  repo="$(printf '%s' "$ctx" | awk '{print $3}')"
  body="$(jq -cn --arg owner "$owner" --arg repo "$repo" --argjson signal "$signal" '{owner:$owner, repo:$repo, signal:$signal}' 2>/dev/null)"
  [ -n "$body" ] || { log "failed to assemble $what payload — skipping"; return 1; }
  command -v curl >/dev/null 2>&1 || { log "curl not available — cannot send $what"; return 1; }
  local auth=()
  [ -n "${AGENT_OUTCOMES_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${AGENT_OUTCOMES_TOKEN}")
  # ${auth[@]+…}: an empty array is "unbound" under set -u in bash 3.2 (macOS).
  if curl -fsS -m 5 -X POST -H 'Content-Type: application/json' ${auth[@]+"${auth[@]}"} -d "$body" "$AGENT_OUTCOMES_ENDPOINT" >>"$LOG" 2>&1; then
    log "sent $what"
  else
    log "POST $what to $AGENT_OUTCOMES_ENDPOINT failed"
    return 1
  fi
}
