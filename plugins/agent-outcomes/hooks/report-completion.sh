#!/usr/bin/env bash
#
# PostToolUse hook: fires after every tool call in a loop's session, and
# tells the agent-orchestration Worker the session is alive. Two signals,
# both to the Worker's POST /routine-signal (worker/src/index.ts in
# umbraco-mcp-ops). A completion is applied by the Worker like the outcome's
# comment (authoritative, deduped against it), so it is sent only for a call that
# posts a comment on the run's own item; the comment stays a second carrier, so
# losing one of the two costs nothing (docs/agent-orchestration/11-outcome-artifact.md):
#
# - completion: the call just posted an agent-outcomes artifact (a comment
#   carrying an <!-- agent-outcome:<routine> --> marker + fenced JSON — see
#   this plugin's SKILL.md). Cancels the run's watchdog early.
# - process (a heartbeat): any other call, at most once per
#   AGENT_OUTCOMES_HEARTBEAT_SECS. Names the step (e.g. "Bash: Run the tests"),
#   which pushes the watchdog's deadline back and is what an expiry quotes,
#   so ai-stuck says what the run was last doing.
#
# Which run this is comes from the session itself: the Worker's fire text,
# the routine's first prompt, carries `route=<routine> repo=<owner>/<repo>
# number=<n>` (routines-client.ts's dispatchText). The hook finds that line
# in the transcript once and caches it. A session without one (an
# interactive session, say) never sends anything.
#
# Deliberately does not validate the outcome's shape — that's
# graph/outcomes.ts's job, the one place this system defines what counts as
# a valid outcome. This forwards it; the Worker decides if it's well-formed.
#
# Matches on marker presence anywhere in tool_input's string values, not on
# tool name — a comment can be posted via the Bash tool + gh CLI (local) or
# a GitHub MCP tool (cloud), and github-ops's whole reason for existing is
# that those two shapes differ. A marker is a marker in either one's raw
# text, so this doesn't need to know which path posted it.
#
# Env knobs:
#   AGENT_OUTCOMES_ENDPOINT        the Worker's .../routine-signal URL. Unset ->
#                                  log a detected outcome only, send nothing.
#   AGENT_OUTCOMES_TOKEN           its bearer secret (tofu output
#                                  routine_signal_secret), for heartbeats; when
#                                  unset a heartbeat goes with the run's own
#                                  log_token (from the fire text), which is
#                                  also what a completion needs. The secret
#                                  signs those tokens, so leave it out of a
#                                  routine environment where the fire text
#                                  carries a log_token.
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

# --- Which run is this? ------------------------------------------------------
# Prints "routine owner repo number", or nothing. Cached per session; the
# last run found is a fallback for a subagent's transcript, which may not
# carry the line (a routine container runs one fire).
run_context() {
  local session transcript cache line
  session="$(printf '%s' "$EVENT" | jq -r '.session_id // "unknown"' 2>/dev/null)"
  cache="$STATE/run-$(printf '%s' "$session" | tr -c 'A-Za-z0-9_-' '_')"
  if [ -f "$cache" ]; then cat "$cache"; return; fi
  transcript="$(printf '%s' "$EVENT" | jq -r '.transcript_path // empty' 2>/dev/null)"
  line=""
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    line="$(grep -o -m1 -E 'route=[a-z-]+ repo=[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+ number=[0-9]+' "$transcript" 2>/dev/null | head -n1)"
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
  if [ -f "$STATE/last-run" ] && [ -n "$(find "$STATE/last-run" -mmin -360 2>/dev/null)" ]; then
    cat "$STATE/last-run"
  fi
}

# The run's own log_token, from the same fire text: it is scoped to this one
# repo, item and routine, and is what the Worker requires for a completion
# (the shared AGENT_OUTCOMES_TOKEN only authorises a heartbeat). Prints
# nothing when the fire carried none.
# Cached like the run, since a subagent's transcript may not carry the fire
# text: the last token this container saw, if recent.
run_token() {
  local transcript token
  transcript="$(printf '%s' "$EVENT" | jq -r '.transcript_path // empty' 2>/dev/null)"
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    token="$(grep -o -m1 -E 'log_token=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' "$transcript" 2>/dev/null | head -n1 | sed 's/^log_token=//')"
    if [ -n "$token" ]; then
      mkdir -p "$STATE" 2>/dev/null || true
      (umask 077; printf '%s' "$token" >"$STATE/last-token" 2>/dev/null) || true
      printf '%s' "$token"
      return 0
    fi
  fi
  if [ -f "$STATE/last-token" ] && [ -n "$(find "$STATE/last-token" -mmin -360 2>/dev/null)" ]; then
    cat "$STATE/last-token"
  fi
}

# send <signal-json> <what> <ctx> [token]: POST {owner, repo, signal} to the Worker.
send() {
  local signal="$1" what="$2" ctx owner repo body token="${4:-}"
  [ -n "$token" ] || token="${AGENT_OUTCOMES_TOKEN:-}"
  ctx="$3"
  owner="$(printf '%s' "$ctx" | awk '{print $2}')"
  repo="$(printf '%s' "$ctx" | awk '{print $3}')"
  body="$(jq -cn --arg owner "$owner" --arg repo "$repo" --argjson signal "$signal" '{owner:$owner, repo:$repo, signal:$signal}' 2>/dev/null)"
  [ -n "$body" ] || { log "failed to assemble $what payload — skipping"; return; }
  command -v curl >/dev/null 2>&1 || { log "curl not available — cannot send $what"; return; }
  local auth=()
  [ -n "$token" ] && auth=(-H "Authorization: Bearer ${token}")
  # ${auth[@]+…}: an empty array is "unbound" under set -u in bash 3.2 (macOS).
  if curl -fsS -m 5 -X POST -H 'Content-Type: application/json' ${auth[@]+"${auth[@]}"} -d "$body" "$AGENT_OUTCOMES_ENDPOINT" >>"$LOG" 2>&1; then
    log "sent $what"
  else
    log "POST $what to $AGENT_OUTCOMES_ENDPOINT failed"
  fi
}

# --- An outcome artifact: completion ----------------------------------------
# Only a call that posts a comment on this run's own item counts: the marker
# turning up in any other tool call (a file, a work-log entry, an echo) is text
# the run copied, possibly from an untrusted comment, and the Worker applies a
# completion as authoritative. The tool and its target are checked, then the
# marker-bearing string is taken from the call.
CTX="$(run_context)"
BLOB=""
if [ -n "$CTX" ] && [ -n "${AGENT_OUTCOMES_ENDPOINT:-}" ]; then
  C_OWNER="$(printf '%s' "$CTX" | awk '{print $2}')"
  C_REPO="$(printf '%s' "$CTX" | awk '{print $3}')"
  C_NUM="$(printf '%s' "$CTX" | awk '{print $4}')"
  BLOB="$(printf '%s' "$EVENT" | jq -r --arg owner "$C_OWNER" --arg repo "$C_REPO" --arg num "$C_NUM" '
    (.tool_name // "") as $t
    | (.tool_input // {}) as $i
    | (($i.issue_number // $i.pullNumber // $i.pull_number // "") | tostring) as $n
    | (($i.owner // $owner) | ascii_downcase) as $o
    | (($i.repo // $repo) | ascii_downcase) as $r
    | (
        ($t | test("^mcp__github__(add_issue_comment|update_issue_comment|pull_request_review_write|add_reply_to_pull_request_comment|add_comment_to_pending_review)$"))
        and ($o == ($owner | ascii_downcase)) and ($r == ($repo | ascii_downcase))
        and (($t | test("update_issue_comment|add_reply_to|add_comment_to_pending")) or $n == $num)
      ) as $mcp
    | (($i.command // "") as $c
       | ($c | [scan("(?:--repo|-R)[ =]+([^ ]+)")] | map(.[0] | ascii_downcase)) as $repos
       | ($t == "Bash") and ($c | test("gh +(issue|pr) +(comment|review) +" + $num + "( |$)"))
         and ($repos | all(. == (($owner + "/" + $repo) | ascii_downcase)))) as $cli
    | if ($mcp or $cli) then
        [$i | .. | strings | select(test("<!-- agent-outcome:"))] | first // empty
      else empty end
  ' 2>/dev/null)"
else
  # Nothing to send (no run, or no endpoint): detect it anywhere in the call, to log it only.
  BLOB="$(printf '%s' "$EVENT" | jq -r '
    [(.tool_input // {}) | .. | strings | select(test("<!-- agent-outcome:"))] | first // empty
  ' 2>/dev/null)"
fi

if [ -n "$BLOB" ]; then
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
  if [ -z "$CTX" ]; then
    log "no route=… repo=… number=… in this session — completion not sent"
    exit 0
  fi
  # The run's own routine (what the Worker fired), so it matches its pending fire.
  SIGNAL="$(jq -cn --arg routine "$(printf '%s' "$CTX" | awk '{print $1}')" \
    --argjson issue "$(printf '%s' "$CTX" | awk '{print $4}')" --argjson outcome "$JSON" \
    '{kind:"completion", routine:$routine, issue:$issue, outcome:$outcome}')"
  TOKEN="$(run_token)"
  [ -n "$TOKEN" ] || log "no log_token in this session — the completion will be refused; its comment still applies"
  send "$SIGNAL" "completion" "$CTX" "$TOKEN"
  exit 0
fi

# --- Any other tool call: a heartbeat ----------------------------------------
# Cheap exits first: no endpoint, or a heartbeat sent too recently.
[ -n "${AGENT_OUTCOMES_ENDPOINT:-}" ] || exit 0
CTX="$(run_context)"
[ -n "$CTX" ] || exit 0

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
# The shared secret when the environment has one, else the run's own token:
# the token's life is bounded, and a long run's heartbeats must outlast it.
send "$SIGNAL" "heartbeat ($STEP)" "$CTX" "${AGENT_OUTCOMES_TOKEN:-$(run_token)}"
exit 0
