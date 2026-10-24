#!/usr/bin/env bash
#
# Deterministic tests for the agent-outcomes hooks (report-completion.sh,
# report-early-end.sh) and skills/agent-outcomes/scripts/post-outcome.sh.
# Hermetic: no network unless AGENT_OUTCOMES_ENDPOINT is set by the test
# itself (against a local stub server), no `claude`. Requires jq + bash.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"           # .../plugins/agent-outcomes
SCRIPT="$PLUGIN_ROOT/hooks/report-completion.sh"
EARLY_END="$PLUGIN_ROOT/hooks/report-early-end.sh"
POST_OUTCOME="$PLUGIN_ROOT/skills/agent-outcomes/scripts/post-outcome.sh"

command -v jq >/dev/null 2>&1 || { echo "FATAL: jq required"; exit 2; }
for f in "$SCRIPT" "$EARLY_END" "$POST_OUTCOME"; do [ -f "$f" ] || { echo "FATAL: $f not found"; exit 2; }; done

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

# 1. An outcome artifact in a tool call is no longer sniffed: nothing is
#    logged as detected, and nothing is sent (an outcome goes through post-outcome.sh).
printf '%s' "$(mcp_event "$SUCCEEDED_COMMENT")" | env AGENT_OUTCOMES_LOG="$WORK/sniff.log" bash "$SCRIPT"
if [ $? -eq 0 ] && ! grep -q 'agent-outcome\|detected outcome' "$WORK/sniff.log" 2>/dev/null; then
  echo "PASS [no_marker_sniffing]"; pass=$((pass+1))
else
  echo "FAIL [no_marker_sniffing]"; fail=$((fail+1))
fi

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

  # 6. An outcome artifact in a tool call -> no signal at all from the heartbeat hook
  signal no_sniff "$(with_transcript "$(bash_event "$SUCCEEDED_COMMENT")" "$TRANSCRIPT")" "$WORK/s6"
  expect_last marker_is_only_a_heartbeat '.body.signal.kind == "process"'

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
  expect_requests no_route_nothing_sent 0

  # 12. A subagent's transcript without the line -> the container's last run
  signal subagent_parent "$(with_transcript "$SKILL_CALL" "$TRANSCRIPT" parent)" "$WORK/s12"
  : >"$SERVER_LOG"
  HB=0 signal subagent "$(with_transcript "$BASH_CALL" "$NO_ROUTE" child)" "$WORK/s12"
  expect_last subagent_uses_last_run '.body.signal.issue == 412 and .body.signal.kind == "process"'

  # --- The early-end hook ----------------------------------------------------
  stop_event() { jq -n '{hook_event_name:"Stop", session_id:"test"}'; }
  end_event() { jq -n --arg r "${1:-other}" '{hook_event_name:"SessionEnd", session_id:"test", reason:$r}'; }
  esignal() {
    printf '%s' "$2" | env AGENT_OUTCOMES_LOG="$WORK/$1.log" AGENT_OUTCOMES_STATE="$3" \
      AGENT_OUTCOMES_ENDPOINT="http://127.0.0.1:8943/routine-signal" AGENT_OUTCOMES_TOKEN="tok" bash "$EARLY_END"
    sleep 0.3
  }

  # 13. A permission prompt -> blocked, naming the tool and the start of its command
  : >"$SERVER_LOG"
  LONG_CMD="git reset --hard $(printf 'x%.0s' $(seq 1 200))"
  PROMPT="$(jq -n --arg c "$LONG_CMD" '{hook_event_name:"Notification", notification_type:"permission_prompt", message:"Claude needs your permission to use Bash", tool_name:"Bash", tool_input:{command:$c}}')"
  esignal blocked "$(with_transcript "$PROMPT" "$TRANSCRIPT" b1)" "$WORK/s13"
  expect_last permission_blocked '.auth == "Bearer tok" and .body.signal.kind == "blocked"
    and .body.signal.routine == "issue-build-loop" and .body.signal.issue == 412
    and (.body.signal.detail | startswith("Bash git reset --hard")) and (.body.signal.detail | length <= 140)'

  # 13b. A session with no route line -> an end sends nothing either
  : >"$SERVER_LOG"
  esignal no_route_end "$(with_transcript "$(stop_event)" "$NO_ROUTE" n1)" "$WORK/s13b"
  expect_requests no_route_end_nothing 0

  # 13c. A credential in the command never goes out
  : >"$SERVER_LOG"
  SECRET="$(jq -n '{hook_event_name:"Notification", notification_type:"permission_prompt", tool_name:"Bash", tool_input:{command:"curl -H \"Authorization: Bearer s3cretvalue\" https://u:pw0rd@x.io/ log_token=eyJabc.def GH=ghp_0123456789abcdef0123456789abcdef0123"}}')"
  esignal secret "$(with_transcript "$SECRET" "$TRANSCRIPT" b3)" "$WORK/s13c"
  expect_last secrets_redacted '.body.signal.kind == "blocked" and (.body.signal.detail | test("s3cretvalue|pw0rd|eyJabc|ghp_0123") | not)'

  # 14. Any other notification (an idle prompt) -> nothing
  : >"$SERVER_LOG"
  IDLE="$(jq -n '{hook_event_name:"Notification", notification_type:"idle_prompt", message:"Claude is waiting for your input"}')"
  esignal idle "$(with_transcript "$IDLE" "$TRANSCRIPT" b2)" "$WORK/s14"
  expect_requests idle_notification_nothing 0

  # 15. A session end with no completion -> ended, with the reason
  : >"$SERVER_LOG"
  esignal ended "$(with_transcript "$(end_event prompt_input_exit)" "$TRANSCRIPT" e1)" "$WORK/s15"
  expect_last session_end_ended '.body.signal.kind == "ended" and .body.signal.issue == 412
    and (.body.signal.detail | contains("prompt_input_exit"))'

  # 16. ...once: a Stop after it sends nothing
  : >"$SERVER_LOG"
  esignal ended_twice "$(with_transcript "$(stop_event)" "$TRANSCRIPT" e1)" "$WORK/s15"
  expect_requests ended_once 0

  # 17. A Stop (the main thread waiting on a background subagent) -> nothing
  : >"$SERVER_LOG"
  esignal stopped "$(with_transcript "$(stop_event)" "$TRANSCRIPT" e2)" "$WORK/s17"
  expect_requests stop_is_not_ended 0

  # 17b. With no endpoint the hooks still record the run, for post-outcome.sh
  printf '%s' "$(with_transcript "$SKILL_CALL" "$TRANSCRIPT" noep)" | env AGENT_OUTCOMES_LOG="$WORK/noep.log" AGENT_OUTCOMES_STATE="$WORK/s17b" bash "$SCRIPT"
  if [ -s "$WORK/s17b/last-run" ] && grep -q 'issue-build-loop hifi-phil umbraco-mcp-ops 412' "$WORK/s17b/last-run"; then echo "PASS [run_recorded_without_endpoint]"; pass=$((pass+1)); else echo "FAIL [run_recorded_without_endpoint]"; fail=$((fail+1)); fi

  # --- post-outcome.sh ---------------------------------------------------------
  # post <name> <state> <outcome> <json>: run it as a session whose transcript carries the run.
  post() {
    env AGENT_OUTCOMES_LOG="$WORK/$1.log" AGENT_OUTCOMES_STATE="$2" AGENT_OUTCOMES_TRANSCRIPT="$TRANSCRIPT" \
      AGENT_OUTCOMES_ENDPOINT="http://127.0.0.1:8943/routine-signal" AGENT_OUTCOMES_TOKEN="tok" \
      bash "$POST_OUTCOME" "$3" "$4"
  }

  # 18. It posts the outcome and prints the exact comment body
  : >"$SERVER_LOG"
  BODY="$(post po_ok "$WORK/s18" build_succeeded '{"outcome":"build_succeeded","pr":123}')"; RC=$?
  WANT='<!-- agent-outcome:issue-build-loop -->
```json
{"outcome":"build_succeeded","pr":123}
```'
  expect_last outcome_sent '.auth == "Bearer tok" and .body.owner == "hifi-phil" and .body.repo == "umbraco-mcp-ops"
    and .body.signal == {kind:"outcome", routine:"issue-build-loop", issue:412, outcome:{outcome:"build_succeeded", pr:123}}'
  if [ "$RC" -eq 0 ] && [ "$BODY" = "$WANT" ]; then echo "PASS [outcome_body_printed]"; pass=$((pass+1)); else echo "FAIL [outcome_body_printed]: rc=$RC body=$BODY"; fail=$((fail+1)); fi

  # 19. Bad JSON, or a name that doesn't match -> non-zero, nothing sent, nothing printed
  : >"$SERVER_LOG"
  OUT="$(post po_bad "$WORK/s19" build_succeeded '{not json' 2>/dev/null)"; RC=$?
  OUT2="$(post po_mismatch "$WORK/s19" build_blocked '{"outcome":"build_succeeded","pr":1}' 2>/dev/null)"; RC2=$?
  if [ "$RC" -ne 0 ] && [ "$RC2" -ne 0 ] && [ -z "$OUT$OUT2" ]; then echo "PASS [outcome_bad_json]"; pass=$((pass+1)); else echo "FAIL [outcome_bad_json]: rc=$RC/$RC2 out=$OUT$OUT2"; fail=$((fail+1)); fi
  expect_requests outcome_bad_json_nothing_sent 0

  # 20. No run context -> non-zero, nothing sent
  OUT="$(env HOME="$WORK/nohome" AGENT_OUTCOMES_LOG="$WORK/po_noctx.log" AGENT_OUTCOMES_STATE="$WORK/s20" AGENT_OUTCOMES_TRANSCRIPT="$NO_ROUTE" \
    AGENT_OUTCOMES_ENDPOINT="http://127.0.0.1:8943/routine-signal" bash "$POST_OUTCOME" build_succeeded '{"outcome":"build_succeeded","pr":1}' 2>/dev/null)"; RC=$?
  if [ "$RC" -ne 0 ] && [ -z "$OUT" ]; then echo "PASS [outcome_no_run]"; pass=$((pass+1)); else echo "FAIL [outcome_no_run]: rc=$RC"; fail=$((fail+1)); fi
  expect_requests outcome_no_run_nothing_sent 0

  # 21. A session end after an outcome -> nothing (same state dir as case 18)
  : >"$SERVER_LOG"
  esignal ended_after "$(with_transcript "$(end_event other)" "$TRANSCRIPT" a1)" "$WORK/s18"
  expect_requests ended_after_outcome_nothing 0

  # 22. The Worker unreachable -> still prints the body, exit 0 (the comment carries the outcome)
  OUT="$(env AGENT_OUTCOMES_LOG="$WORK/po_down.log" AGENT_OUTCOMES_STATE="$WORK/s22" AGENT_OUTCOMES_TRANSCRIPT="$TRANSCRIPT" \
    AGENT_OUTCOMES_ENDPOINT="http://127.0.0.1:1/routine-signal" bash "$POST_OUTCOME" build_succeeded '{"outcome":"build_succeeded","pr":9}' 2>/dev/null)"; RC=$?
  if [ "$RC" -eq 0 ] && [ "$OUT" != "${OUT#<!-- agent-outcome:issue-build-loop -->}" ]; then echo "PASS [outcome_worker_down]"; pass=$((pass+1)); else echo "FAIL [outcome_worker_down]: rc=$RC"; fail=$((fail+1)); fi
else
  echo "SKIP [signals]: python3 not available for the stub server"
fi

echo "-----"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
