#!/usr/bin/env bash
#
# Async proto-learning capture for mcp-issue-loop.
#   $1 = scope: "subagent" (SubagentStop) | "orchestrator" (SessionEnd)
#
# Reads the hook event JSON from stdin, finds the transcript, and — only if it
# belongs to an mcp-issue-loop run — asks an analyzer whether anything worth
# improving happened. The analyzer captures directly: it appends a row to the
# shared "MCP Loop Learnings" Slack canvas itself (its one write tool) when
# something's worth recording — there is no GitHub issue path. Filing
# proto-learnings as issues on hifi-phil/umbraco-mcp-ops needed that repo and
# the working repo to share a GitHub App installation, which silently isn't
# true once a cloud routine works an `umbraco/*` repo (a different org); the
# canvas has no such boundary. Runs off the critical path (hook is async).
#
# Env knobs (ops + test):
#   MCP_ISSUE_LOOP_ANALYZER_OUT   inject a canned analyzer decision (skip `claude`)
#   MCP_ISSUE_LOOP_LOG            override the log file path
#   MCP_ISSUE_LOOP_CANVAS_ID      Slack canvas to append to (default: the shared
#                                 "MCP Loop Learnings" canvas in #mcp-ops-learning)
#   MCP_ISSUE_LOOP_CAPTURE=1      re-entry guard (set internally; do not set by hand)
set -uo pipefail

SCOPE="${1:-subagent}"
CANVAS_ID="${MCP_ISSUE_LOOP_CANVAS_ID:-F0BQ31E4R8F}"
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
# response is injected).
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

# --- Once-per-session guard ------------------------------------------------
# transcript_path is the WHOLE shared session JSONL, not a per-subagent slice.
# Resuming a stuck subagent fires another SubagentStop over the same (growing)
# transcript, so without this we'd re-analyse the same session repeatedly — the
# analyzer eventually bails on "already been through this". Analyse each session
# once per scope; the marker is written after the analyzer runs (below).
SID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty' 2>/dev/null)"
MARKER=""
if [ -n "$SID" ]; then
  MARKER="$(dirname "$LOG")/analyzed-$SCOPE-$SID"
  if [ -f "$MARKER" ]; then log "session $SID ($SCOPE) already analysed — skipping"; exit 0; fi
fi

PROMPT_FILE="$PLUGIN_ROOT/hooks/analyzer-$SCOPE.md"
[ -f "$PROMPT_FILE" ] || { log "no prompt file $PROMPT_FILE — skipping"; exit 0; }

# --- Analyze + capture (the analyzer appends to the canvas itself) --------
PROMPT="$(sed -e "s#{{TRANSCRIPT}}#$TRANSCRIPT#g" \
              -e "s#{{SCHEMA}}#$SCHEMA#g" \
              -e "s#{{CANVAS_ID}}#$CANVAS_ID#g" "$PROMPT_FILE")"

log "analyzing $TRANSCRIPT"
if [ -n "${MCP_ISSUE_LOOP_ANALYZER_OUT:-}" ]; then
  # Test seam: inject a canned analyzer response instead of calling the model.
  OUT="$MCP_ISSUE_LOOP_ANALYZER_OUT"
else
  command -v claude >/dev/null 2>&1 || { log "missing claude — skipping capture"; exit 0; }
  # Read,Grep stay read-only over the transcript/schema; the two Slack tools
  # are the one write this analyzer has, scoped to a single canvas — present
  # only if the environment has the Slack connector attached, which the
  # analyzer prompt is told to tolerate the absence of.
  OUT="$(claude -p "$PROMPT" --model sonnet \
    --allowedTools "Read,Grep,mcp__Slack__slack_read_canvas,mcp__Slack__slack_update_canvas" \
    2>>"$LOG")" || {
    log "analyzer invocation failed"; exit 0; }
fi

# Mark this session/scope analysed so a later SubagentStop (e.g. a resumed
# subagent) doesn't re-run the analyzer over the same growing transcript.
[ -n "$MARKER" ] && { : >"$MARKER" 2>/dev/null || true; }

# The analyzer performs the canvas write itself (its own tool call, above) and
# reports back a small JSON summary purely for this log — nothing below takes
# any write action of its own.
JSON="$(printf '%s' "$OUT" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//' | jq -c . 2>/dev/null)"
if [ -z "$JSON" ]; then log "analyzer output not JSON: $(printf '%s' "$OUT" | head -c 200)"; exit 0; fi

if [ "$(printf '%s' "$JSON" | jq -r '.file // false')" = "true" ]; then
  log "captured: $(printf '%s' "$JSON" | jq -r '.lesson // "(no summary)"')"
else
  log "analyzer decided SKIP"
fi
