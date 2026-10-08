#!/usr/bin/env bash
#
# Adds an entry to, or reads, the agent-orchestration work log
# (docs/agent-orchestration/16-work-log.md in umbraco-mcp-ops): the journal,
# the decision list derived from it, and the build entries. The work-log
# skill says when and what to write.
#
#   log-entry.sh --token <log_token> add journal <category>                  < body
#   log-entry.sh --token <log_token> add decision <category> [--refs 7,9]    < one line
#   log-entry.sh --token <log_token> add build                               < body
#   log-entry.sh --token <log_token> read <item>
#
# The token comes from the Worker's fire text (log_token=…). It names the
# repo, the issue or PR, and the routine, so an add goes to that item only;
# a read may name any item in the same repo.
#
# Best effort, always: every path exits 0. A failed add prints
# "not logged: <why>"; a failed read prints "(log unavailable: <why>)". A run
# never stops because of the log.
#
# Env knobs:
#   WORK_LOG_TOKEN           the token, instead of --token.
#   WORK_LOG_ENDPOINT        the Worker's .../log URL. Unset -> derived from
#                            AGENT_OUTCOMES_ENDPOINT (…/routine-signal -> …/log).
set -uo pipefail

MAX_BYTES=4096
CATEGORIES="assumption deviation workaround judgment-call"

usage() {
  cat <<'USAGE'
log-entry.sh: add to, or read, the agent-orchestration work log.

Usage:
  log-entry.sh --token <log_token> add journal <category>                 < body
  log-entry.sh --token <log_token> add decision <category> [--refs 7,9]   < one line
  log-entry.sh --token <log_token> add build                              < body
  log-entry.sh --token <log_token> read <item>
  log-entry.sh --help | -h

Kinds (add):
  journal    a decision record, written as you choose
  decision   one line per choice a person should know about
  build      what the run did and checked (no category)

Categories (journal and decision): assumption, deviation, workaround, judgment-call

--refs 7,9   decision only: the journal entry ids behind it.
read <item>  an issue or PR number; prints its entries.

Token:    --token <log_token>, else WORK_LOG_TOKEN. The log_token comes from the
          Worker's fire text.
Endpoint: WORK_LOG_ENDPOINT (the Worker's .../log URL), else derived from
          AGENT_OUTCOMES_ENDPOINT (.../routine-signal -> .../log).

Bodies are capped at 4096 bytes. It never fails a run: every path exits 0.
USAGE
}

case "${1:-}" in -h | --help) usage; exit 0 ;; esac

TOKEN="${WORK_LOG_TOKEN:-}"
if [ "${1:-}" = "--token" ]; then TOKEN="${2:-}"; shift 2 || true; fi
CMD="${1:-}"

fail() {
  if [ "$CMD" = "read" ]; then echo "(log unavailable: $1)"; else echo "not logged: $1"; fi
  exit 0
}

command -v curl >/dev/null 2>&1 || fail "curl not available"
command -v jq >/dev/null 2>&1 || fail "jq not available"
[ -n "$TOKEN" ] || fail "no log_token (pass --token, from the fire text)"

ENDPOINT="${WORK_LOG_ENDPOINT:-}"
if [ -z "$ENDPOINT" ] && [ -n "${AGENT_OUTCOMES_ENDPOINT:-}" ]; then
  ENDPOINT="${AGENT_OUTCOMES_ENDPOINT%/routine-signal}/log"
fi
[ -n "$ENDPOINT" ] || fail "no endpoint (WORK_LOG_ENDPOINT or AGENT_OUTCOMES_ENDPOINT)"

case "$CMD" in
  add)
    KIND="${2:-}"
    CATEGORY="${3:-}"
    REFS=""
    if [ "${4:-}" = "--refs" ]; then REFS="${5:-}"; fi
    case "$KIND" in
      journal | decision)
        [ -n "$CATEGORY" ] || fail "a $KIND entry needs a category: $CATEGORIES"
        case " $CATEGORIES " in *" $CATEGORY "*) ;; *) fail "unknown category '$CATEGORY': $CATEGORIES" ;; esac
        ;;
      build) CATEGORY="" ;;
      *) fail "kind must be journal, decision or build" ;;
    esac
    if [ -n "$REFS" ]; then
      [ "$KIND" = "decision" ] || fail "--refs is for a decision (the journal entries behind it)"
      case "$REFS" in *[!0-9,]* | ,* | *, | *,,*) fail "--refs takes journal entry ids, like 7,9" ;; esac
    fi
    BODY="$(cat)"
    [ -n "${BODY//[[:space:]]/}" ] || fail "empty body"
    [ "$(printf '%s' "$BODY" | wc -c | tr -d ' ')" -le "$MAX_BYTES" ] || fail "body over $MAX_BYTES bytes: shorten it"
    if [ "$KIND" = "decision" ]; then
      BODY="$(printf '%s' "$BODY" | sed -e 's/[[:space:]]*$//')"
      case "$BODY" in *$'\n'*) fail "a decision is one line (the journal holds the detail)" ;; esac
    fi
    PAYLOAD="$(jq -cn --arg kind "$KIND" --arg category "$CATEGORY" --arg body "$BODY" --arg refs "$REFS" \
      '{kind:$kind, body:$body}
        + (if $category == "" then {} else {category:$category} end)
        + (if $refs == "" then {} else {refs:($refs | split(",") | map(tonumber))} end)')"
    if RESPONSE="$(curl -sS -m 10 -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
      -d "$PAYLOAD" -w '\n%{http_code}' "$ENDPOINT" 2>&1)"; then
      STATUS="${RESPONSE##*$'\n'}"
      BODY_OUT="${RESPONSE%$'\n'*}"
      if [ "$STATUS" = "200" ] || [ "$STATUS" = "201" ]; then
        echo "logged: $KIND$( [ -n "$CATEGORY" ] && echo " ($CATEGORY)") #$(printf '%s' "$BODY_OUT" | jq -r '.id // "?"' 2>/dev/null)"
      else
        fail "the Worker answered $STATUS: $(printf '%s' "$BODY_OUT" | head -c 200)"
      fi
    else
      fail "couldn't reach the Worker"
    fi
    ;;
  read)
    ITEM="${2:-}"
    case "$ITEM" in '' | *[!0-9]*) fail "read needs an issue or PR number" ;; esac
    if RESPONSE="$(curl -sS -m 10 -H "Authorization: Bearer $TOKEN" -w '\n%{http_code}' "$ENDPOINT?item=$ITEM" 2>&1)"; then
      STATUS="${RESPONSE##*$'\n'}"
      BODY_OUT="${RESPONSE%$'\n'*}"
      [ "$STATUS" = "200" ] || fail "the Worker answered $STATUS"
      printf '%s' "$BODY_OUT" | jq -r '
        if (.entries | length) == 0 then "(no entries)"
        else .entries[] | "#\(.id) \(.created_at) \(.routine) \(.kind)\(if .category then " · " + .category else "" end)\(if (.refs // []) | length > 0 then " (refs " + ((.refs // []) | map("#" + tostring) | join(", ")) + ")" else "" end)\n\(.body)\n"
        end' 2>/dev/null || fail "unreadable answer"
    else
      fail "couldn't reach the Worker"
    fi
    ;;
  *)
    CMD=add
    fail "usage: log-entry.sh --token <log_token> add journal <category> | add decision <category> [--refs 7,9] | add build | read <item>"
    ;;
esac
exit 0
