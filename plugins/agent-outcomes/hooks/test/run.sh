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

# 6. AGENT_OUTCOMES_ENDPOINT set and reachable -> the artifact is actually
#    POSTed there, with the routine name attached.
if command -v python3 >/dev/null 2>&1; then
  SERVER_LOG="$WORK/server.log"
  python3 -c '
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        with open(sys.argv[1], "ab") as f:
            f.write(body + b"\n")
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 8943), H).serve_forever()
' "$SERVER_LOG" &
  SERVER_PID=$!
  trap 'kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"' EXIT
  for _ in $(seq 1 20); do curl -fsS -m 1 http://127.0.0.1:8943/ >/dev/null 2>&1 && break; sleep 0.1; done

  log="$WORK/forward.log"
  printf '%s' "$(bash_event "$SUCCEEDED_COMMENT")" | \
    env AGENT_OUTCOMES_LOG="$log" AGENT_OUTCOMES_ENDPOINT="http://127.0.0.1:8943/outcomes" bash "$SCRIPT"
  sleep 0.2
  if [ -f "$SERVER_LOG" ] && grep -qF '"routine":"issue-build-loop"' "$SERVER_LOG" && grep -qF '"outcome":"build_succeeded"' "$SERVER_LOG"; then
    echo "PASS [forwarded_to_endpoint]"; pass=$((pass+1))
  else
    echo "FAIL [forwarded_to_endpoint]: server never received the expected body"
    [ -f "$SERVER_LOG" ] && sed 's/^/  /' "$SERVER_LOG"
    fail=$((fail+1))
  fi
else
  echo "SKIP [forwarded_to_endpoint]: python3 not available for the stub server"
fi

echo "-----"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
