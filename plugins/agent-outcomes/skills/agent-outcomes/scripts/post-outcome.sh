#!/usr/bin/env bash
#
# post-outcome.sh <outcome> '<json>' — how a loop reports its outcome.
#
# 1. Reads the run (`route=<routine> repo=<owner>/<repo> number=<n>`) the same
#    way hooks/report-completion.sh does: from the session's own first prompt.
# 2. Validates that <json> parses.
# 3. POSTs {kind:"outcome", routine, issue, outcome} to the Worker's
#    /routine-signal (AGENT_OUTCOMES_ENDPOINT, bearer AGENT_OUTCOMES_TOKEN),
#    retrying once. The Worker applies it as authoritative; the comment below
#    is the same fact by the other road, and whichever lands second is deduped.
# 4. Prints the exact comment body (the marker plus the fenced JSON) on stdout
#    for the session to post. Nothing else goes to stdout.
#
# Exits non-zero, with a message on stderr, on bad JSON or no run context —
# and sends nothing. A failed POST is not an error: the comment still carries
# the outcome, so the body is printed and the exit is 0.
#
# <outcome> is the outcome's name (e.g. build_succeeded). The JSON must carry
# the same name in its "outcome" field. graph/outcomes.ts decides the rest.
#
# Env: AGENT_OUTCOMES_ENDPOINT, AGENT_OUTCOMES_TOKEN, AGENT_OUTCOMES_STATE
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
JSON="$(printf '%s' "$JSON" | jq -c .)"

# --- Which run is this? ------------------------------------------------------
# The fire text is the session's first prompt. Look for it where it's found:
# the cache the hooks keep, an explicit transcript, then the newest transcript.
LINE_RE='route=[a-z-]+ repo=[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+ number=[0-9]+'
CTX=""
parse_line() {
  local line="$1"
  printf '%s %s %s %s\n' \
    "$(printf '%s' "$line" | sed -E 's/route=([a-z-]+) .*/\1/')" \
    "$(printf '%s' "$line" | sed -E 's/.* repo=([^/]+)\/.*/\1/')" \
    "$(printf '%s' "$line" | sed -E 's/.* repo=[^/]+\/([^ ]+) .*/\1/')" \
    "$(printf '%s' "$line" | sed -E 's/.* number=([0-9]+).*/\1/')"
}
if [ -n "${AGENT_OUTCOMES_TRANSCRIPT:-}" ] && [ -f "$AGENT_OUTCOMES_TRANSCRIPT" ]; then
  line="$(grep -o -m1 -E "$LINE_RE" "$AGENT_OUTCOMES_TRANSCRIPT" 2>/dev/null | head -n1)"
  [ -n "$line" ] && CTX="$(parse_line "$line")"
fi
if [ -z "$CTX" ] && [ -f "$STATE/last-run" ] && [ -n "$(find "$STATE/last-run" -mmin -360 2>/dev/null)" ]; then
  CTX="$(cat "$STATE/last-run")"
fi
if [ -z "$CTX" ]; then
  for t in $(ls -t "${HOME}"/.claude/projects/*/*.jsonl 2>/dev/null | head -n 5); do
    line="$(grep -o -m1 -E "$LINE_RE" "$t" 2>/dev/null | head -n1)"
    if [ -n "$line" ]; then CTX="$(parse_line "$line")"; break; fi
  done
fi
[ -n "$CTX" ] || die "no run context (route=… repo=… number=…) found in this session — nothing sent"

ROUTINE="$(printf '%s' "$CTX" | awk '{print $1}')"
OWNER="$(printf '%s' "$CTX" | awk '{print $2}')"
REPO="$(printf '%s' "$CTX" | awk '{print $3}')"
ISSUE="$(printf '%s' "$CTX" | awk '{print $4}')"
mkdir -p "$STATE" 2>/dev/null || true
printf '%s' "$CTX" >"$STATE/last-run" 2>/dev/null || true

# --- The authoritative POST ----------------------------------------------------
if [ -n "${AGENT_OUTCOMES_ENDPOINT:-}" ] && command -v curl >/dev/null 2>&1; then
  BODY="$(jq -cn --arg owner "$OWNER" --arg repo "$REPO" --arg routine "$ROUTINE" \
    --argjson issue "$ISSUE" --argjson outcome "$JSON" \
    '{owner:$owner, repo:$repo, signal:{kind:"outcome", routine:$routine, issue:$issue, outcome:$outcome}}')"
  auth=()
  [ -n "${AGENT_OUTCOMES_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${AGENT_OUTCOMES_TOKEN}")
  sent=0
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
fi

# The run has reported (the comment below carries it even if the POST didn't
# get through): the Stop/SessionEnd hooks send no "ended" for it.
touch "$STATE/reported-$(printf '%s' "$CTX" | tr -c 'A-Za-z0-9_-' '_')" 2>/dev/null || true

# --- The comment body ------------------------------------------------------------
printf '<!-- agent-outcome:%s -->\n```json\n%s\n```\n' "$ROUTINE" "$JSON"
