#!/usr/bin/env bash
#
# Deterministic tests for report-completion.sh.
# Hermetic: no network unless AGENT_OUTCOMES_ENDPOINT is set by the test
# itself (against a local stub server), no `claude`. Requires jq + bash.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"           # .../plugins/agent-outcomes
SCRIPT="$PLUGIN_ROOT/hooks/report-completion.sh"

command -v jq >/dev/null 2>&1 || { echo "FATAL: jq required"; exit 2; }
[ -f "$SCRIPT" ] || { echo "FATAL: $SCRIPT not found"; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0 fail=0

# bash_event <comment-body>: a PostToolUse event as it'd look for the local
# Bash-tool + gh-CLI path (github-ops's "local" side of its dual path).
bash_event() {
  jq -n --arg body "$1" '{
    hook_event_name: "PostToolUse",
    session_id: "test",
    tool_name: "Bash",
    tool_input: {command: ("gh issue comment 412 --body " + ($body | @sh))}
  }'
}

# mcp_event <comment-body>: the same artifact posted via the cloud path's
# GitHub MCP tool — structured field, not a shell command string.
mcp_event() {
  jq -n --arg body "$1" '{
    hook_event_name: "PostToolUse",
    session_id: "test",
    tool_name: "mcp__github__add_issue_comment",
    tool_input: {body: $body}
  }'
}

SUCCEEDED_COMMENT='PR opened: https://github.com/x/y/pull/123

<!-- agent-outcome:issue-build-loop -->
```json
{"outcome":"build_succeeded","pr":123}
```'

BLOCKED_COMMENT='Blocked: CI-green cap tripped after 8 attempts.

<!-- agent-outcome:issue-build-loop -->
```json
{"outcome":"build_blocked","reason":"CI-green cap tripped after 8 attempts"}
```'

MALFORMED_COMMENT='PR opened.

<!-- agent-outcome:issue-build-loop -->
```json
{not valid json at all
```'

# run_case <name> <event-json> <expect-substring-in-log>
run_case() {
  local name="$1" event="$2" expect="$3"
  local log="$WORK/$name.log"
  printf '%s' "$event" | env AGENT_OUTCOMES_LOG="$log" bash "$SCRIPT"
  local rc=$?
  if [ "$rc" -ne 0 ]; then echo "FAIL [$name]: exit=$rc (expected 0)"; fail=$((fail+1)); return; fi
  if grep -qF "$expect" "$log" 2>/dev/null; then
    echo "PASS [$name]"; pass=$((pass+1))
  else
    echo "FAIL [$name]: log missing '$expect'"; echo "  --- log ---"; sed 's/^/  /' "$log" 2>/dev/null; fail=$((fail+1))
  fi
}

# run_case_no_log <name> <event-json>: expects a clean exit and NO log file
# at all (the cheap pre-filter should return before ever opening the log).
run_case_no_log() {
  local name="$1" event="$2"
  local log="$WORK/$name.log"
  printf '%s' "$event" | env AGENT_OUTCOMES_LOG="$log" bash "$SCRIPT"
  local rc=$?
  if [ "$rc" -eq 0 ] && [ ! -e "$log" ]; then
    echo "PASS [$name]"; pass=$((pass+1))
  else
    echo "FAIL [$name]: exit=$rc, log exists=$([ -e "$log" ] && echo yes || echo no)"; fail=$((fail+1))
  fi
}

# 1. Local (Bash+gh) build_succeeded artifact is detected and extracted
run_case bash_succeeded "$(bash_event "$SUCCEEDED_COMMENT")" \
  'detected outcome artifact for routine=issue-build-loop: {"outcome":"build_succeeded","pr":123}'

# 2. Cloud (GitHub MCP tool) build_blocked artifact is detected too
run_case mcp_blocked "$(mcp_event "$BLOCKED_COMMENT")" \
  'detected outcome artifact for routine=issue-build-loop: {"outcome":"build_blocked","reason":"CI-green cap tripped after 8 attempts"}'

# 3. No AGENT_OUTCOMES_ENDPOINT set -> logs only, no network attempted
run_case bash_no_endpoint "$(bash_event "$SUCCEEDED_COMMENT")" \
  "AGENT_OUTCOMES_ENDPOINT not set — logged only, no live target yet"

# 4. An unrelated tool call (no marker at all) -> exits clean, never even
#    opens the log — the cheap pre-filter is the very first thing checked.
run_case_no_log unrelated "$(jq -n '{hook_event_name:"PostToolUse", session_id:"test", tool_name:"Read", tool_input:{file_path:"/tmp/x"}}')"

# 5. Marker present but the JSON is malformed -> skip, not a throw
run_case bash_malformed "$(bash_event "$MALFORMED_COMMENT")" \
  "could not extract a well-formed routine+JSON pair — skipping"

# --- Signals to the Worker's /routine-signal, against a local stub server ---
# The server records each request as one JSON line: {auth, body}.
if command -v python3 >/dev/null 2>&1; then
  SERVER_LOG="$WORK/server.log"
  python3 -c '
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        with open(sys.argv[1], "a") as f:
            f.write(json.dumps({"auth": self.headers.get("Authorization"), "body": body}) + "\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 8943), H).serve_forever()
' "$SERVER_LOG" &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"' EXIT
  for _ in $(seq 1 20); do curl -fsS -m 1 -X POST -d '{}' http://127.0.0.1:8943/ >/dev/null 2>&1 && break; sleep 0.1; done
  : >"$SERVER_LOG"

  # A routine's transcript: its first prompt is the Worker's fire text.
  TRANSCRIPT="$WORK/transcript.jsonl"
  jq -cn '{type:"user", message:{content:"loop-dispatch (cloud worker). A GitHub loop event was routed at the edge: route=issue-build-loop repo=hifi-phil/umbraco-mcp-ops number=412. Run the loop-dispatch skill…"}}' >"$TRANSCRIPT"
  NO_ROUTE="$WORK/plain.jsonl"
  jq -cn '{type:"user", message:{content:"help me refactor this"}}' >"$NO_ROUTE"

  # with_transcript <event-json> <transcript>: the event as the hook gets it.
  with_transcript() { printf '%s' "$1" | jq -c --arg t "$2" --arg s "${3:-sess-1}" '. + {transcript_path:$t, session_id:$s}'; }

  # signal <name> <event-json> <state-dir>: run the hook against the stub.
  signal() {
    printf '%s' "$2" | env AGENT_OUTCOMES_LOG="$WORK/$1.log" AGENT_OUTCOMES_STATE="$3" \
      AGENT_OUTCOMES_ENDPOINT="http://127.0.0.1:8943/routine-signal" AGENT_OUTCOMES_TOKEN="tok" AGENT_OUTCOMES_HEARTBEAT_SECS="${HB:-60}" bash "$SCRIPT"
    sleep 0.3
  }
  # expect_last <name> <jq-filter over the last request, must be true>
  expect_last() {
    if [ -s "$SERVER_LOG" ] && tail -n1 "$SERVER_LOG" | jq -e "$2" >/dev/null 2>&1; then
      echo "PASS [$1]"; pass=$((pass+1))
    else
      echo "FAIL [$1]: last request didn't match $2"; tail -n1 "$SERVER_LOG" 2>/dev/null | sed 's/^/  /'; fail=$((fail+1))
    fi
  }
  # expect_requests <name> <count>
  expect_requests() {
    local n; n="$(wc -l <"$SERVER_LOG" | tr -d ' ')"
    if [ "$n" -eq "$2" ]; then echo "PASS [$1]"; pass=$((pass+1)); else echo "FAIL [$1]: $n requests, expected $2"; fail=$((fail+1)); fi
  }

  # 6. An outcome artifact -> a completion signal in the Worker's shape, with the bearer token
  signal completion "$(with_transcript "$(bash_event "$SUCCEEDED_COMMENT")" "$TRANSCRIPT")" "$WORK/s6"
  expect_last completion_shape '.auth == "Bearer tok"
    and .body.owner == "hifi-phil" and .body.repo == "umbraco-mcp-ops"
    and .body.signal == {kind:"completion", routine:"issue-build-loop", issue:412, outcome:{outcome:"build_succeeded", pr:123}}'

  # 7. Any other call -> a heartbeat naming the step (tool + its own description)
  BASH_CALL="$(jq -n '{hook_event_name:"PostToolUse", tool_name:"Bash", tool_input:{command:"npm test", description:"Run the tests"}}')"
  signal heartbeat "$(with_transcript "$BASH_CALL" "$TRANSCRIPT")" "$WORK/s7"
  expect_last heartbeat_shape '.auth == "Bearer tok" and .body.owner == "hifi-phil"
    and .body.signal == {kind:"process", routine:"issue-build-loop", issue:412, step:"Bash: Run the tests"}'

  # 8. A second call inside the heartbeat gap -> no second request
  : >"$SERVER_LOG"
  signal heartbeat_again "$(with_transcript "$BASH_CALL" "$TRANSCRIPT")" "$WORK/s7"
  expect_requests heartbeat_rate_limited 0

  # 9. The step never carries a command (an expiry quotes it on GitHub)
  SECRET_CALL="$(jq -n '{hook_event_name:"PostToolUse", tool_name:"Bash", tool_input:{command:"curl -H \"Authorization: Bearer s3cret\" x"}}')"
  signal no_secret "$(with_transcript "$SECRET_CALL" "$TRANSCRIPT")" "$WORK/s9"
  expect_last step_without_command '.body.signal.step == "Bash" and (tostring | contains("s3cret") | not)'

  # 10. A skill call names the skill
  SKILL_CALL="$(jq -n '{hook_event_name:"PostToolUse", tool_name:"Skill", tool_input:{skill:"mcp-review"}}')"
  signal skill "$(with_transcript "$SKILL_CALL" "$TRANSCRIPT")" "$WORK/s10"
  expect_last skill_step '.body.signal.step == "Skill: mcp-review"'

  # 11. A session with no route line (an interactive one) -> nothing sent, either signal
  : >"$SERVER_LOG"
  signal no_route_beat "$(with_transcript "$BASH_CALL" "$NO_ROUTE")" "$WORK/s11"
  signal no_route_done "$(with_transcript "$(bash_event "$SUCCEEDED_COMMENT")" "$NO_ROUTE")" "$WORK/s11"
  expect_requests no_route_nothing_sent 0

  # 12. A subagent's transcript without the line -> the container's last run
  signal subagent_parent "$(with_transcript "$SKILL_CALL" "$TRANSCRIPT" parent)" "$WORK/s12"
  : >"$SERVER_LOG"
  HB=0 signal subagent "$(with_transcript "$BASH_CALL" "$NO_ROUTE" child)" "$WORK/s12"
  expect_last subagent_uses_last_run '.body.signal.issue == 412 and .body.signal.kind == "process"'
else
  echo "SKIP [signals]: python3 not available for the stub server"
fi

echo "-----"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
