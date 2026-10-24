#!/usr/bin/env bash
#
# post-outcome.sh <outcome> '<json>' — how a loop reports its outcome.
#
# 1. Validates that <json> parses and that its "outcome" matches <outcome>.
# 2. Finds the run (`route=<routine> repo=<owner>/<repo> number=<n>`): the
#    explicit transcript if given, else the last run the hooks recorded, else
#    the newest session transcripts (the fire text is the session's first prompt).
# 3. POSTs {kind:"outcome", routine, issue, outcome} to the Worker's
#    /routine-signal (AGENT_OUTCOMES_ENDPOINT, bearer AGENT_OUTCOMES_TOKEN),
#    retrying once. The Worker applies it as authoritative; the comment below
#    is the same fact by the other road, and whichever lands second is deduped.
# 4. Prints the exact comment body (the marker plus the fenced JSON) on stdout
#    for the session to post. Nothing else goes to stdout.
#
# Exits non-zero, with a message on stderr, on bad JSON or an outcome-name
# mismatch, and sends nothing. Neither a failed POST nor a missing run context
# is an error: the comment still carries the outcome (the Worker recovers it
# from there), so the body is printed, with a note on stderr, and the exit is 0.
#
# <outcome> is the outcome's name (e.g. build_succeeded). The JSON must carry
# the same name in its "outcome" field. graph/outcomes.ts decides the rest.
#
# Env: CLAUDE_CONFIG_DIR (default ~/.claude, where the session transcripts are),
# AGENT_OUTCOMES_ENDPOINT, AGENT_OUTCOMES_TOKEN, AGENT_OUTCOMES_STATE
# (default ~/.cache/agent-outcomes), AGENT_OUTCOMES_LOG, AGENT_OUTCOMES_TRANSCRIPT
# (the session transcript to read the run from, when it can't be found).
set -uo pipefail

STATE="${AGENT_OUTCOMES_STATE:-${HOME}/.cache/agent-outcomes}"
LOG="${AGENT_OUTCOMES_LOG:-${STATE}/capture.log}"
log() {
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  printf '%s %s\n' "$(date -u +%FT%TZ 2>/dev/null || echo now)" "$*" >>"$LOG" 2>/dev/null || true
}
die() { echo "post-outcome.sh: $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: post-outcome.sh <outcome> '<json>'"
command -v jq >/dev/null 2>&1 || die "jq is required"
OUTCOME="$1"
JSON="$2"

printf '%s' "$JSON" | jq -e 'type == "object"' >/dev/null 2>&1 || die "the outcome JSON doesn't parse as an object — nothing sent"
NAME="$(printf '%s' "$JSON" | jq -r '.outcome // empty')"
[ "$NAME" = "$OUTCOME" ] || die "the JSON's \"outcome\" ($NAME) isn't $OUTCOME — nothing sent"
# escape backticks so a ```-bearing field cannot end the json fence early
JSON="$(printf '%s' "$JSON" | jq -c . | sed 's/`/\\u0060/g')"

# --- Which run is this? ------------------------------------------------------
# The fire text is the session's first prompt. Look for it in order: an
# explicit transcript, the last run the hooks recorded (recent), then the
# newest session transcripts.
LINE_RE='route=[a-z-]+ repo=[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+ number=[0-9]+'
CTX=""
SOURCE=""
parse_line() {
  local line="$1"
  printf '%s %s %s %s\n' \
    "$(printf '%s' "$line" | sed -E 's/route=([a-z-]+) .*/\1/')" \
    "$(printf '%s' "$line" | sed -E 's/.* repo=([^/]+)\/.*/\1/')" \
    "$(printf '%s' "$line" | sed -E 's/.* repo=[^/]+\/([^ ]+) .*/\1/')" \
    "$(printf '%s' "$line" | sed -E 's/.* number=([0-9]+).*/\1/')"
}
# first_prompt_line <transcript>: the run line from the session's first user entry only.
first_prompt_line() {
  jq -c 'select(.type == "user")' "$1" 2>/dev/null | head -n1 | grep -o -m1 -E "$LINE_RE" | head -n1
}
if [ -n "${AGENT_OUTCOMES_TRANSCRIPT:-}" ] && [ -f "$AGENT_OUTCOMES_TRANSCRIPT" ]; then
  line="$(first_prompt_line "$AGENT_OUTCOMES_TRANSCRIPT")"
  [ -n "$line" ] && { CTX="$(parse_line "$line")"; SOURCE="transcript"; }
fi
if [ -z "$CTX" ] && [ -f "$STATE/last-run" ] && [ -n "$(find "$STATE/last-run" -mmin -360 2>/dev/null)" ]; then
  CTX="$(cat "$STATE/last-run")"; SOURCE="the last run this container saw"
fi
if [ -z "$CTX" ]; then
  # Hooks not registered, or no tool call has run one yet: scan the newest transcripts.
  # shellcheck disable=SC2012
  for t in $(ls -t "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/*.jsonl 2>/dev/null | head -n 5); do
    [ -n "$(find "$t" -mmin -360 2>/dev/null)" ] || continue
    line="$(first_prompt_line "$t")"
    [ -n "$line" ] && { CTX="$(parse_line "$line")"; SOURCE="a recent session transcript"; break; }
  done
fi
if [ -z "$CTX" ]; then
  # Nothing to send the Worker, but the comment still carries the outcome.
  echo "post-outcome.sh: no run context (route=… repo=… number=…) found in this session; nothing sent, post the comment below" >&2
  log "no run context — outcome $OUTCOME printed, not sent"
  # The catalog's outcome names say which routine reports them.
  case "$OUTCOME" in
    build_*) ROUTINE=issue-build-loop ;;
    release_blocked|release_approved) ROUTINE=auto-release-loop ;;
    release_published) ROUTINE=release-publish ;;
    review_*) ROUTINE=review-loop ;;
    rework_*) ROUTINE=rework-loop ;;
    merge_*) ROUTINE=merge-flow ;;
    discussion_*) ROUTINE=issue-discuss-loop ;;
    *) die "no run context found and $OUTCOME isn't in the catalog — nothing sent" ;;
  esac
  printf '<!-- agent-outcome:%s -->\n```json\n%s\n```\n' "$ROUTINE" "$JSON"
  exit 0
fi

ROUTINE="$(printf '%s' "$CTX" | awk '{print $1}')"
OWNER="$(printf '%s' "$CTX" | awk '{print $2}')"
REPO="$(printf '%s' "$CTX" | awk '{print $3}')"
ISSUE="$(printf '%s' "$CTX" | awk '{print $4}')"
echo "post-outcome.sh: reporting for $ROUTINE $OWNER/$REPO#$ISSUE (from ${SOURCE})" >&2
mkdir -p "$STATE" 2>/dev/null || true
printf '%s' "$CTX" >"$STATE/last-run" 2>/dev/null || true

# --- The authoritative POST ----------------------------------------------------
sent=0
if [ -n "${AGENT_OUTCOMES_ENDPOINT:-}" ] && command -v curl >/dev/null 2>&1; then
  BODY="$(jq -cn --arg owner "$OWNER" --arg repo "$REPO" --arg routine "$ROUTINE" \
    --argjson issue "$ISSUE" --argjson outcome "$JSON" \
    '{owner:$owner, repo:$repo, signal:{kind:"outcome", routine:$routine, issue:$issue, outcome:$outcome}}')"
  auth=()
  [ -n "${AGENT_OUTCOMES_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${AGENT_OUTCOMES_TOKEN}")
  for attempt in 1 2; do
    if curl -fsS -m 10 -X POST -H 'Content-Type: application/json' ${auth[@]+"${auth[@]}"} \
         -d "$BODY" "$AGENT_OUTCOMES_ENDPOINT" >>"$LOG" 2>&1; then
      sent=1; break
    fi
    [ "$attempt" -eq 1 ] && sleep 1
  done
  if [ "$sent" -eq 1 ]; then
    log "sent outcome $OUTCOME ($ROUTINE #$ISSUE)"
  else
    log "POST outcome $OUTCOME to $AGENT_OUTCOMES_ENDPOINT failed twice — the comment still carries it"
    echo "post-outcome.sh: could not reach the Worker; post the comment below" >&2
  fi
else
  log "AGENT_OUTCOMES_ENDPOINT not set (or no curl) — outcome $OUTCOME printed, not sent"
  echo "post-outcome.sh: AGENT_OUTCOMES_ENDPOINT unset or curl missing; nothing sent, post the comment below" >&2
fi

# Only a sent outcome stops the SessionEnd hook sending "ended": if the
# POST failed, the run is reported only if the session posts the comment below.
[ "$sent" -eq 1 ] && touch "$STATE/reported-$(printf '%s' "$CTX" | tr -c 'A-Za-z0-9_-' '_')" 2>/dev/null
true

# --- The comment body ------------------------------------------------------------
printf '<!-- agent-outcome:%s -->\n```json\n%s\n```\n' "$ROUTINE" "$JSON"
