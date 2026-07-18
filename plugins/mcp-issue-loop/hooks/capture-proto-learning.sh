#!/usr/bin/env bash
#
# Async proto-learning capture for mcp-issue-loop.
#   $1 = scope: "subagent" (SubagentStop) | "orchestrator" (SessionEnd)
#
# Reads the hook event JSON from stdin, finds the transcript, and — only if it
# belongs to an mcp-issue-loop run — asks a read-only analyzer whether anything
# worth improving happened. If so, files ONE `proto-learning` issue on the ops
# repo. The analyzer has no write tools; this script does the deterministic
# `gh issue create`. Runs off the critical path (hook is async).
#
# Env knobs (ops + test):
#   MCP_ISSUE_LOOP_DRY_RUN=1      log the intended issue instead of filing (no gh)
#   MCP_ISSUE_LOOP_ANALYZER_OUT   inject a canned analyzer decision (skip `claude`)
#   MCP_ISSUE_LOOP_LOG            override the log file path
#   MCP_ISSUE_LOOP_CAPTURE=1      re-entry guard (set internally; do not set by hand)
set -uo pipefail

SCOPE="${1:-subagent}"
OPS_REPO="hifi-phil/umbraco-mcp-ops"
LABEL="proto-learning"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SCHEMA="$PLUGIN_ROOT/skills/mcp-issue-loop/references/proto-learning-schema.md"
LOG="${MCP_ISSUE_LOOP_LOG:-${HOME}/.cache/mcp-issue-loop/capture.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
log() { printf '%s [%s] %s\n' "$(date -u +%FT%TZ 2>/dev/null || echo now)" "$SCOPE" "$*" >>"$LOG" 2>/dev/null || true; }

# --- Re-entry guard --------------------------------------------------------
# The analyzer below is itself a `claude` session that loads this plugin, so its
# own SessionEnd/SubagentStop would re-invoke this script. The env var is
# inherited by that child and its hooks, so they exit here instead of recursing.
if [ -n "${MCP_ISSUE_LOOP_CAPTURE:-}" ]; then exit 0; fi
export MCP_ISSUE_LOOP_CAPTURE=1

# --- Preconditions ---------------------------------------------------------
# jq is always needed; `claude` only when actually analyzing (not when a canned
# response is injected), `gh` only when actually filing (checked at those points).
command -v jq >/dev/null 2>&1 || { log "missing jq — skipping capture"; exit 0; }

EVENT="$(cat)"
TRANSCRIPT="$(printf '%s' "$EVENT" | jq -r '.transcript_path // empty' 2>/dev/null)"
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  log "no readable transcript_path — skipping"; exit 0
fi

# --- Cheap pre-filter: only act on mcp-issue-loop runs ---------------------
# Avoids spawning an analyzer for unrelated subagents/sessions.
if ! grep -qiE 'mcp-issue-loop|content-issue-loop|ready-for-ai' "$TRANSCRIPT" 2>/dev/null; then
  log "transcript has no loop signature — skipping"; exit 0
fi

PROMPT_FILE="$PLUGIN_ROOT/hooks/analyzer-$SCOPE.md"
[ -f "$PROMPT_FILE" ] || { log "no prompt file $PROMPT_FILE — skipping"; exit 0; }

# --- Analyze (read-only) ---------------------------------------------------
PROMPT="$(sed -e "s#{{TRANSCRIPT}}#$TRANSCRIPT#g" \
              -e "s#{{SCHEMA}}#$SCHEMA#g" \
              -e "s#{{OPS_REPO}}#$OPS_REPO#g" "$PROMPT_FILE")"

log "analyzing $TRANSCRIPT"
if [ -n "${MCP_ISSUE_LOOP_ANALYZER_OUT:-}" ]; then
  # Test seam: inject a canned analyzer response instead of calling the model.
  OUT="$MCP_ISSUE_LOOP_ANALYZER_OUT"
else
  command -v claude >/dev/null 2>&1 || { log "missing claude — skipping capture"; exit 0; }
  OUT="$(claude -p "$PROMPT" --model sonnet --allowedTools "Read,Grep" 2>>"$LOG")" || {
    log "analyzer invocation failed"; exit 0; }
fi

# The analyzer outputs a single JSON object (optionally fenced). Strip fences.
JSON="$(printf '%s' "$OUT" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//' | jq -c . 2>/dev/null)"
if [ -z "$JSON" ]; then log "analyzer output not JSON: $(printf '%s' "$OUT" | head -c 200)"; exit 0; fi

if [ "$(printf '%s' "$JSON" | jq -r '.file // false')" != "true" ]; then
  log "analyzer decided SKIP"; exit 0
fi

TITLE="$(printf '%s' "$JSON" | jq -r '.title // empty')"
RECORD="$(printf '%s' "$JSON" | jq '.record // {}')"
NOTES="$(printf '%s' "$JSON" | jq -r '.notes // ""')"
[ -n "$TITLE" ] || { log "no title in analyzer output — skipping"; exit 0; }

BODY="$(printf '```json\n%s\n```\n\n**Notes:** %s\n' "$(printf '%s' "$RECORD" | jq .)" "$NOTES")"

# --- Dry-run: log the intended issue and stop (no gh, fully hermetic) -------
if [ -n "${MCP_ISSUE_LOOP_DRY_RUN:-}" ]; then
  log "DRY_RUN — would file title: $TITLE"
  log "DRY_RUN — would file body: $(printf '%s' "$BODY" | tr '\n' '|')"
  exit 0
fi

# --- Filing needs gh from here on ------------------------------------------
command -v gh >/dev/null 2>&1 || { log "missing gh — skipping capture"; exit 0; }

# --- Dedup: skip an obvious exact-title match already open -----------------
if gh issue list --repo "$OPS_REPO" --label "$LABEL" --state open --search "$TITLE" \
     --json title --jq '.[].title' 2>/dev/null | grep -qxF "$TITLE"; then
  log "duplicate open proto-learning, skipping: $TITLE"; exit 0
fi

# --- File it ---------------------------------------------------------------
if URL="$(gh issue create --repo "$OPS_REPO" --label "$LABEL" --title "$TITLE" --body "$BODY" 2>>"$LOG")"; then
  log "filed proto-learning: $URL"
else
  log "gh issue create failed for: $TITLE"
fi
