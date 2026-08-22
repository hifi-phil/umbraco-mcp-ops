#!/usr/bin/env bash
#
# Async proto-learning capture, shared across every automated loop in this
# repo's self-learning system — see the pre-filter below for how it decides
# "loop-driven" without naming any of them individually.
#   $1 = scope: "subagent" (SubagentStop) | "orchestrator" (SessionEnd)
#
# Reads the hook event JSON from stdin, finds the transcript, and — only if it
# looks like one of this repo's automated loops ran — asks an analyzer whether
# anything worth improving happened. The analyzer captures directly: it
# appends a row to the shared "MCP Loop Learnings" Slack canvas itself (its
# one write tool) when something's worth recording — there is no GitHub issue
# path. Filing proto-learnings as issues on hifi-phil/umbraco-mcp-ops needed
# that repo and the working repo to share a GitHub App installation, which
# silently isn't true once a cloud routine works an `umbraco/*` repo (a
# different org); the canvas has no such boundary. Runs off the critical path:
# the hook is async, and the analyzer itself is spawned detached and stripped
# of this session's inbound-message bindings — see "Isolate the analyzer" below
# for why that second part matters.
#
# This is its own plugin (not bundled into mcp-issue-loop or any other loop)
# because it's shared infrastructure: it fires on every SubagentStop/SessionEnd
# in the session regardless of which loop is running — hooks aren't scoped to
# the skill that triggered them. Deliberately does not hardcode any other
# loop's name: adding a new loop to this repo needs no edit here, since the
# pre-filter below matches on this ecosystem's shared conventions
# (`github-ops`, `/goal`), not an enumerated list.
#
# Env knobs (ops + test):
#   SELF_LEARNING_ANALYZER_OUT   inject a canned analyzer decision (skip `claude`)
#   SELF_LEARNING_LOG            override the log file path
#   SELF_LEARNING_CANVAS_ID      Slack canvas to append to (default: the shared
#                                "MCP Loop Learnings" canvas in #mcp-ops-learning)
#   SELF_LEARNING_CAPTURE=1      re-entry guard (set internally; do not set by hand)
set -uo pipefail

SCOPE="${1:-subagent}"
CANVAS_ID="${SELF_LEARNING_CANVAS_ID:-F0BQ31E4R8F}"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SCHEMA="$PLUGIN_ROOT/skills/proto-learning-capture/references/proto-learning-schema.md"
LOG="${SELF_LEARNING_LOG:-${HOME}/.cache/self-learning/capture.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
log() { printf '%s [%s] %s\n' "$(date -u +%FT%TZ 2>/dev/null || echo now)" "$SCOPE" "$*" >>"$LOG" 2>/dev/null || true; }

# --- Re-entry guard --------------------------------------------------------
# The analyzer below is itself a `claude` session that loads this plugin, so its
# own SessionEnd/SubagentStop would re-invoke this script. The env var is
# inherited by that child and its hooks, so they exit here instead of recursing.
if [ -n "${SELF_LEARNING_CAPTURE:-}" ]; then exit 0; fi
export SELF_LEARNING_CAPTURE=1

# --- Preconditions ---------------------------------------------------------
# jq is always needed; `claude` only when actually analyzing (not when a canned
# response is injected).
command -v jq >/dev/null 2>&1 || { log "missing jq — skipping capture"; exit 0; }

EVENT="$(cat)"
TRANSCRIPT="$(printf '%s' "$EVENT" | jq -r '.transcript_path // empty' 2>/dev/null)"
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  log "no readable transcript_path — skipping"; exit 0
fi

# --- Cheap pre-filter: only act on this repo's automated loops -------------
# Avoids spawning an analyzer for unrelated subagents/sessions. Matches on
# ecosystem-wide conventions every loop here follows (github-ops is the shared
# GitHub dependency every loop defers to; /goal drives the autonomous ones;
# ready-for-ai is the issue-driven ones' trigger label) rather than naming
# individual loops — a new loop needs no edit here. False positives are cheap:
# the analyzer below makes the real, content-based call and just answers
# `{"file":false}` if this wasn't loop-driven work after all.
if ! grep -qiE 'github-ops|/goal|ready-for-ai' "$TRANSCRIPT" 2>/dev/null; then
  log "transcript has no loop signature — skipping"; exit 0
fi

# --- Once-per-session guard ------------------------------------------------
# transcript_path is the WHOLE shared session JSONL, not a per-subagent slice.
# Resuming a stuck subagent fires another SubagentStop over the same (growing)
# transcript, so without this we'd re-analyse the same session repeatedly — the
# analyzer eventually bails on "already been through this". Analyse each session
# once per scope. The marker is *claimed* here rather than written once the
# analyzer returns: the analyzer now runs detached (below), so two hook fires
# for one session would otherwise both get past a plain existence check and run
# overlapping analyzers. `set -C` makes the claim atomic; it is released again
# only on the one path where no analyzer actually ran.
SID="$(printf '%s' "$EVENT" | jq -r '.session_id // empty' 2>/dev/null)"
MARKER=""
release_marker() { [ -n "$MARKER" ] && rm -f "$MARKER" 2>/dev/null; return 0; }
if [ -n "$SID" ]; then
  MARKER="$(dirname "$LOG")/analyzed-$SCOPE-$SID"
  if ! ( set -C; : >"$MARKER" ) 2>/dev/null; then
    log "session $SID ($SCOPE) already analysed — skipping"; exit 0
  fi
fi

PROMPT_FILE="$PLUGIN_ROOT/hooks/analyzer-$SCOPE.md"
[ -f "$PROMPT_FILE" ] || { log "no prompt file $PROMPT_FILE — skipping"; release_marker; exit 0; }

# --- Analyze + capture (the analyzer appends to the canvas itself) --------
PROMPT="$(sed -e "s#{{TRANSCRIPT}}#$TRANSCRIPT#g" \
              -e "s#{{SCHEMA}}#$SCHEMA#g" \
              -e "s#{{CANVAS_ID}}#$CANVAS_ID#g" "$PROMPT_FILE")"

# The analyzer performs the canvas write itself (its own tool call) and reports
# back a small JSON summary purely for this log — nothing here takes any write
# action of its own.
record() {
  local out="$1" json
  json="$(printf '%s' "$out" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//' | jq -c . 2>/dev/null)"
  if [ -z "$json" ]; then log "analyzer output not JSON: $(printf '%s' "$out" | head -c 200)"; return 0; fi
  if [ "$(printf '%s' "$json" | jq -r '.file // false')" = "true" ]; then
    log "captured: $(printf '%s' "$json" | jq -r '.lesson // "(no summary)"')"
  else
    log "analyzer decided SKIP"
  fi
}

log "analyzing $TRANSCRIPT"
if [ -n "${SELF_LEARNING_ANALYZER_OUT:-}" ]; then
  # Test seam: inject a canned analyzer response instead of calling the model.
  record "$SELF_LEARNING_ANALYZER_OUT"
  exit 0
fi

command -v claude >/dev/null 2>&1 || { log "missing claude — skipping capture"; release_marker; exit 0; }

# --- Isolate the analyzer from the invoking session ------------------------
# The analyzer is a nested `claude`, and a child inherits the vars that bind a
# process to *this* session's inbound message channel: the runner's messaging
# socket + token, the session ingress token file, and the session ids. With
# those inherited the analyzer joins the very loop session it is analyzing, so
# a live event meant for the loop — a CI webhook, or the loop's own
# self-scheduled `send_later` check-in — can be delivered into the analyzer's
# turn and never reach the loop's driving logic. That has starved a loop's
# check-in and stalled a release mid-flight. Drop them so the analyzer can only
# ever run as its own unaddressable session. CLAUDE_PID is in the list because
# the socket path is derived from it. The OAuth token fd is deliberately NOT
# dropped — that is what authenticates the analyzer, not what addresses it.
ISOLATE=(env
  -u CLAUDE_CODE_MESSAGING_SOCKET
  -u CLAUDE_CODE_MESSAGING_TOKEN
  -u CLAUDE_SESSION_INGRESS_TOKEN_FILE
  -u CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2
  -u CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
  -u CLAUDE_CODE_REMOTE_SESSION_ID
  -u CLAUDE_CODE_SESSION_ID
  -u CLAUDE_PID
)
# New process session too, where the tool exists (not on macOS): the hook fires
# as the loop session is ending, so staying in its process group means the
# analyzer is torn down with it. Detached, it outlives that teardown.
if command -v setsid >/dev/null 2>&1; then ISOLATE=(setsid "${ISOLATE[@]}"); fi

# Run detached and return immediately: nothing on the loop's side, not even
# this already-async hook process, then has the analyzer in front of it.
# Read,Grep stay read-only over the transcript/schema; the two Slack tools are
# the one write this analyzer has, scoped to a single canvas — present only if
# the environment has the Slack connector attached, which the analyzer prompt
# is told to tolerate the absence of.
(
  OUT="$("${ISOLATE[@]}" claude -p "$PROMPT" --model sonnet \
    --allowedTools "Read,Grep,mcp__Slack__slack_read_canvas,mcp__Slack__slack_update_canvas" \
    2>>"$LOG")" || { log "analyzer invocation failed"; release_marker; exit 0; }
  record "$OUT"
) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
