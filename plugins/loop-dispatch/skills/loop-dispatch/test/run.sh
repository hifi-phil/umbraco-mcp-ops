#!/usr/bin/env bash
#
# Deterministic tests for route-event.sh — the loop-dispatch routing decision.
# Hermetic: bash + jq only, no network, no gh, no claude. Runs in a few ms.
#
# Usage: bash run.sh   (exits non-zero if any case fails)
set -uo pipefail

# Isolate from any ambient GitHub-event env (GitHub Actions sets these to the
# workflow's OWN event, which would otherwise shadow the stdin payloads we feed in).
unset GITHUB_EVENT_PATH GITHUB_EVENT_NAME

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/route-event.sh"
[ -f "$SCRIPT" ] || { echo "FATAL: route-event.sh not found at $SCRIPT"; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "FATAL: jq required"; exit 2; }

pass=0 fail=0

# expect_route <name> <expected-route> -- <args...>   (args after -- go to route-event.sh)
expect_route() {
  local name="$1" want="$2"; shift 2; [ "$1" = "--" ] && shift
  local out; out="$(bash "$SCRIPT" "$@" </dev/null)"
  local got="${out#route=}"; got="${got%% *}"
  if [ "$got" = "$want" ]; then pass=$((pass+1)); # echo "ok: $name"
  else fail=$((fail+1)); echo "FAIL: $name — want route=$want, got: $out"; fi
}

# expect_line <name> <expected-full-line> < stdin-json ... (via here-string)
expect_json() {
  local name="$1" want="$2" json="$3" evt="$4"
  local out; out="$(printf '%s' "$json" | bash "$SCRIPT" --event "$evt")"
  if [ "$out" = "$want" ]; then pass=$((pass+1));
  else fail=$((fail+1)); echo "FAIL: $name — want [$want], got [$out]"; fi
}

# --- flag-driven cases -----------------------------------------------------
expect_route "pr auto-merge → merge-flow"          merge-flow        -- --event pull_request --action labeled --label auto-merge --number 42 --repo o/r
expect_route "pr dependencies → none (the 4x bug)" none              -- --event pull_request --action labeled --label dependencies --number 269 --repo o/r
expect_route "pr javascript → none"                none              -- --event pull_request --action labeled --label javascript --number 7 --repo o/r
expect_route "pr opened → none"                    none              -- --event pull_request --action opened --number 42 --repo o/r
expect_route "issue ready-for-ai → mcp-issue-loop" mcp-issue-loop    -- --event issues --action labeled --label ready-for-ai --number 5 --repo o/r
expect_route "issue auto-release → auto-release"   auto-release-loop -- --event issues --action labeled --label auto-release --number 9 --repo o/r
expect_route "issue bug → none"                    none              -- --event issues --action labeled --label bug --number 3 --repo o/r
expect_route "review changes → rework-loop"        rework-loop       -- --event pull_request_review --action submitted --state changes_requested --number 42 --repo o/r
expect_route "review approved → none"              none              -- --event pull_request_review --action submitted --state approved --number 42 --repo o/r
expect_route "review state UPPER → rework-loop"    rework-loop       -- --event pull_request_review --action submitted --state CHANGES_REQUESTED --number 42 --repo o/r
expect_route "unknown event → none"                none              -- --event release --action published --number 1 --repo o/r
expect_route "no input at all → none"              none              --

# --- raw-JSON payload cases (event name passed separately, as GitHub does) --
expect_json "raw json auto-merge PR" \
  "route=merge-flow repo=a/b number=7" \
  '{"action":"labeled","label":{"name":"auto-merge"},"pull_request":{"number":7},"repository":{"full_name":"a/b"}}' \
  pull_request
expect_json "raw json dependencies PR → none" \
  "route=none repo=a/b number=269" \
  '{"action":"labeled","label":{"name":"dependencies"},"pull_request":{"number":269},"repository":{"full_name":"a/b"}}' \
  pull_request
expect_json "raw json ready-for-ai issue" \
  "route=mcp-issue-loop repo=a/b number=5" \
  '{"action":"labeled","label":{"name":"ready-for-ai"},"issue":{"number":5},"repository":{"full_name":"a/b"}}' \
  issues
expect_json "raw json review changes_requested" \
  "route=rework-loop repo=a/b number=8" \
  '{"action":"submitted","review":{"state":"changes_requested"},"pull_request":{"number":8},"repository":{"full_name":"a/b"}}' \
  pull_request_review

echo "----"
echo "route-event tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
