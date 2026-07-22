#!/usr/bin/env bash
#
# Deterministic tests for capture-proto-learning.sh.
# Hermetic: no `claude`, no `gh`, no network. Uses the MCP_ISSUE_LOOP_ANALYZER_OUT
# and MCP_ISSUE_LOOP_DRY_RUN seams and an overridden log path. Requires only jq + bash.
#
# Usage: bash run.sh   (exits non-zero if any case fails)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"          # .../plugins/mcp-issue-loop
SCRIPT="$PLUGIN_ROOT/hooks/capture-proto-learning.sh"
FIX="$HERE/fixtures"
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"

command -v jq >/dev/null 2>&1 || { echo "FATAL: jq required"; exit 2; }
[ -f "$SCRIPT" ] || { echo "FATAL: $SCRIPT not found"; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0 fail=0

event_for() { printf '{"transcript_path":"%s","hook_event_name":"%s","session_id":"test"}\n' "$1" "${2:-SubagentStop}"; }

# run_case <name> <scope> <expect-substring> [env assignments...] -- reads event JSON on stdin
run_case() {
  local name="$1" scope="$2" expect="$3"; shift 3
  # Per-case dir so the once-per-session marker (analyzed-<scope>-<sid>, written
  # beside the log) can't leak between cases that share session_id "test".
  local dir="$WORK/$name"; mkdir -p "$dir"
  local log="$dir/capture.log"
  env MCP_ISSUE_LOOP_LOG="$log" "$@" bash "$SCRIPT" "$scope"
  local rc=$?
  if [ "$rc" -ne 0 ]; then echo "FAIL [$name]: exit=$rc (expected 0)"; fail=$((fail+1)); return; fi
  if grep -qF "$expect" "$log" 2>/dev/null; then
    echo "PASS [$name]"; pass=$((pass+1))
  else
    echo "FAIL [$name]: log missing '$expect'"; echo "  --- log ---"; sed 's/^/  /' "$log" 2>/dev/null; fail=$((fail+1))
  fi
}

FILE_JSON='{"file":true,"title":"[proto-learning] umbraco/Umbraco-CMS-MCP-Editor#52: versionId needs z.guid()","record":{"sourceRepo":"umbraco/Umbraco-CMS-MCP-Editor","sourceIssue":52,"pr":141,"category":"repo-gotcha","lesson":"use z.guid() for Umbraco version ids","detail":"CI -32602 with z.string().uuid()","fix":"z.guid()","guessedHome":"shared-mcp-skills","modelTier":"sonnet","phase":"build"},"notes":"add-tool should mention this"}'

# 1. Pre-filter rejects a non-loop transcript (never reaches the analyzer)
run_case prefilter subagent "no loop signature — skipping" \
  < <(event_for "$FIX/unrelated.jsonl")

# 2. Loop transcript + injected SKIP decision
run_case skip subagent "analyzer decided SKIP" MCP_ISSUE_LOOP_ANALYZER_OUT='{"file":false}' \
  < <(event_for "$FIX/loop-build.jsonl")

# 3. Injected FILE + DRY_RUN — parse + body build, nothing filed
run_case file_dryrun subagent "DRY_RUN — would file title: [proto-learning] umbraco/Umbraco-CMS-MCP-Editor#52" \
  MCP_ISSUE_LOOP_DRY_RUN=1 MCP_ISSUE_LOOP_ANALYZER_OUT="$FILE_JSON" \
  < <(event_for "$FIX/loop-build.jsonl")

# 4. Orchestrator scope path (SessionEnd) also parses + dry-run files
run_case orchestrator_dryrun orchestrator "DRY_RUN — would file title:" \
  MCP_ISSUE_LOOP_DRY_RUN=1 MCP_ISSUE_LOOP_ANALYZER_OUT="$FILE_JSON" \
  < <(event_for "$FIX/loop-build.jsonl" SessionEnd)

# 5. Re-entry guard: exits immediately, writes nothing
guard_log="$WORK/guard.log"
env MCP_ISSUE_LOOP_LOG="$guard_log" MCP_ISSUE_LOOP_CAPTURE=1 bash "$SCRIPT" subagent < <(event_for "$FIX/loop-build.jsonl")
if [ $? -eq 0 ] && [ ! -s "$guard_log" ]; then echo "PASS [reentry_guard]"; pass=$((pass+1)); else echo "FAIL [reentry_guard]: expected clean exit + empty log"; fail=$((fail+1)); fi

# 6. Missing / unreadable transcript
run_case no_transcript subagent "no readable transcript_path — skipping" \
  < <(event_for "$WORK/does-not-exist.jsonl")

# 7. Malformed analyzer output is rejected, not filed
run_case bad_json subagent "analyzer output not JSON" MCP_ISSUE_LOOP_ANALYZER_OUT='not json at all' \
  < <(event_for "$FIX/loop-build.jsonl")

# 8. Once-per-session guard: a second SubagentStop for the same session skips
#    re-analysis (mirrors a resumed subagent firing another SubagentStop).
guard_dir="$WORK/once"; mkdir -p "$guard_dir"; guard2_log="$guard_dir/capture.log"
env MCP_ISSUE_LOOP_LOG="$guard2_log" MCP_ISSUE_LOOP_DRY_RUN=1 MCP_ISSUE_LOOP_ANALYZER_OUT="$FILE_JSON" \
  bash "$SCRIPT" subagent < <(event_for "$FIX/loop-build.jsonl") >/dev/null 2>&1
env MCP_ISSUE_LOOP_LOG="$guard2_log" MCP_ISSUE_LOOP_DRY_RUN=1 MCP_ISSUE_LOOP_ANALYZER_OUT="$FILE_JSON" \
  bash "$SCRIPT" subagent < <(event_for "$FIX/loop-build.jsonl") >/dev/null 2>&1
if grep -qF "already analysed — skipping" "$guard2_log" 2>/dev/null; then
  echo "PASS [once_per_session]"; pass=$((pass+1))
else
  echo "FAIL [once_per_session]: second run did not skip"; echo "  --- log ---"; sed 's/^/  /' "$guard2_log" 2>/dev/null; fail=$((fail+1))
fi

echo "-----"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
