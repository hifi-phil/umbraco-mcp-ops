#!/usr/bin/env bash
#
# Deterministic tests for log-entry.sh, against a local stub of the Worker's
# /log. Hermetic: no network beyond 127.0.0.1. Requires bash, curl, jq, python3.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/log-entry.sh"

for t in jq curl python3; do command -v "$t" >/dev/null 2>&1 || { echo "FATAL: $t required"; exit 2; }; done
[ -f "$SCRIPT" ] || { echo "FATAL: $SCRIPT not found"; exit 2; }

WORK="$(mktemp -d)"
SERVER_LOG="$WORK/server.log"
PORT=8944
pass=0 fail=0

# The stub records each request as one JSON line {method, path, auth, body};
# POST answers {"id":7}, GET answers two entries, and a "Bearer bad" token
# gets a 401.
python3 -c '
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def record(self, body):
        with open(sys.argv[1], "a") as f:
            f.write(json.dumps({"method": self.command, "path": self.path, "auth": self.headers.get("Authorization"), "body": body}) + "\n")
    def answer(self, code, obj):
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps(obj).encode())
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        self.record(body)
        if self.headers.get("Authorization") == "Bearer bad": return self.answer(401, {"error": "bad token"})
        self.answer(200, {"id": 7})
    def do_GET(self):
        self.record(None)
        self.answer(200, {"entries": [
            {"id": 1, "created_at": "2026-10-07 10:00:00", "routine": "issue-build-loop", "kind": "decision", "category": "judgment-call", "body": "Decided: cursors."},
            {"id": 2, "created_at": "2026-10-07 10:30:00", "routine": "issue-build-loop", "kind": "build", "category": None, "body": "Commit: abc1234"}]})
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[2])), H).serve_forever()
' "$SERVER_LOG" "$PORT" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 30); do curl -s -m 1 "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 0.1; done

ENDPOINT="http://127.0.0.1:$PORT/log"
run() { env -u WORK_LOG_ENDPOINT -u AGENT_OUTCOMES_ENDPOINT -u WORK_LOG_TOKEN "$@"; }

# check <name> <actual> <expected-substring>
check() {
  if [[ "$2" == *"$3"* ]]; then echo "PASS [$1]"; pass=$((pass+1)); else echo "FAIL [$1]: got '$2', wanted '$3'"; fail=$((fail+1)); fi
}
# last <name> <jq filter over the last request, must be true>
last() {
  if [ -s "$SERVER_LOG" ] && tail -n1 "$SERVER_LOG" | jq -e "$2" >/dev/null 2>&1; then echo "PASS [$1]"; pass=$((pass+1))
  else echo "FAIL [$1]: last request didn't match $2"; tail -n1 "$SERVER_LOG" 2>/dev/null | sed 's/^/  /'; fail=$((fail+1)); fi
}
requests() { wc -l <"$SERVER_LOG" 2>/dev/null | tr -d ' '; }

# 1. A decision: posted with its category and the bearer token.
out="$(printf 'Decided: cursors.\nWhy: thousands of rows.\nRejected: offsets.' | run WORK_LOG_ENDPOINT="$ENDPOINT" bash "$SCRIPT" --token tok add decision judgment-call)"
check decision_logged "$out" "logged: decision (judgment-call) #7"
last decision_shape '.method == "POST" and .path == "/log" and .auth == "Bearer tok"
  and .body == {kind:"decision", category:"judgment-call", body:"Decided: cursors.\nWhy: thousands of rows.\nRejected: offsets."}'

# 2. A build entry: no category sent, token from the env.
out="$(printf 'Commit: abc1234\nTests: 42/42' | run WORK_LOG_ENDPOINT="$ENDPOINT" WORK_LOG_TOKEN=tok bash "$SCRIPT" add build)"
check build_logged "$out" "logged: build #7"
last build_shape '.body == {kind:"build", body:"Commit: abc1234\nTests: 42/42"}'

# 3. The endpoint derived from the outcome hook's.
out="$(echo 'Commit: abc' | run AGENT_OUTCOMES_ENDPOINT="http://127.0.0.1:$PORT/routine-signal" bash "$SCRIPT" --token tok add build)"
check derived_endpoint "$out" "logged: build"
last derived_path '.path == "/log"'

# 4. Read: the entries, as text, for the item asked.
out="$(run WORK_LOG_ENDPOINT="$ENDPOINT" bash "$SCRIPT" --token tok read 412)"
check read_decision "$out" "#1 2026-10-07 10:00:00 issue-build-loop decision · judgment-call"
check read_build "$out" "Commit: abc1234"
last read_request '.method == "GET" and .path == "/log?item=412" and .auth == "Bearer tok"'

# 5. Refused before sending: each prints why, exits 0, and sends nothing.
before="$(requests)"
refuse() { # refuse <name> <expected> <stdin> <args…>
  local name="$1" want="$2" input="$3"; shift 3
  local got code
  got="$(printf '%s' "$input" | run WORK_LOG_ENDPOINT="$ENDPOINT" bash "$SCRIPT" "$@")"; code=$?
  check "$name" "$got" "$want"
  [ "$code" -eq 0 ] && { echo "PASS [${name}_exit0]"; pass=$((pass+1)); } || { echo "FAIL [${name}_exit0]: exit $code"; fail=$((fail+1)); }
}
refuse no_token "not logged: no log_token" "x" add build
refuse no_category "not logged: a decision needs a category" "x" --token tok add decision
refuse bad_category "not logged: unknown category 'guess'" "x" --token tok add decision guess
refuse bad_kind "not logged: kind must be decision or build" "x" --token tok add note
refuse empty_body "not logged: empty body" "   " --token tok add build
refuse too_long "not logged: body over 4096 bytes" "$(head -c 5000 /dev/zero | tr '\0' 'a')" --token tok add build
refuse bad_item "(log unavailable: read needs an issue or PR number" "" --token tok read abc
after="$(requests)"
[ "$before" = "$after" ] && { echo "PASS [refusals_send_nothing]"; pass=$((pass+1)); } || { echo "FAIL [refusals_send_nothing]: $((after-before)) sent"; fail=$((fail+1)); }

# 6. No endpoint configured: why, exit 0.
out="$(echo x | run bash "$SCRIPT" --token tok add build)"; code=$?
check no_endpoint "$out" "not logged: no endpoint"

# 7. The Worker says no: its answer is quoted, still exit 0.
out="$(echo x | run WORK_LOG_ENDPOINT="$ENDPOINT" bash "$SCRIPT" --token bad add build)"; code=$?
check refused_by_worker "$out" "not logged: the Worker answered 401"
[ "$code" -eq 0 ] && { echo "PASS [refused_exit0]"; pass=$((pass+1)); } || { echo "FAIL [refused_exit0]"; fail=$((fail+1)); }

# 8. The Worker unreachable: why, exit 0.
out="$(echo x | run WORK_LOG_ENDPOINT="http://127.0.0.1:1/log" bash "$SCRIPT" --token tok add build)"; code=$?
check unreachable "$out" "not logged: couldn't reach the Worker"
out="$(run WORK_LOG_ENDPOINT="http://127.0.0.1:1/log" bash "$SCRIPT" --token tok read 1)"
check unreachable_read "$out" "(log unavailable: couldn't reach the Worker"

echo "work-log tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
