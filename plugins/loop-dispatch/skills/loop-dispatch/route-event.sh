#!/usr/bin/env bash
# route-event.sh — deterministic loop-dispatch router.
#
# Decides which loop (if any) a GitHub webhook event maps to. Pure function of the
# event fields — same inputs always give the same output, no model judgement. Run at the
# EDGE by the caller GitHub Action (reads the Actions event); it fires the routine only
# when the printed route is not `none`, and the routine's loop-dispatch skill just
# dispatches that already-resolved route.
#
# Inputs (in priority order):
#   1. flags: --event --action --label --state --number --repo
#   2. a raw GitHub event JSON on stdin or at $GITHUB_EVENT_PATH (parsed with jq);
#      the event NAME comes from --event or $GITHUB_EVENT_NAME (it's an HTTP header,
#      not part of the JSON body).
#
# Output: one line of `key=value` pairs on stdout, always exit 0:
#   route=<mcp-issue-loop|auto-release-loop|merge-flow|rework-loop|none> repo=<r> number=<n>
# route=none means "not ours — quiet no-op". `none` is a normal outcome, not an error.
#
# Unknown / missing / unmatched fields always resolve to route=none. It never guesses.
set -uo pipefail

event="" action="" label="" state="" number="" repo=""

while [ $# -gt 0 ]; do
  case "$1" in
    --event)  event="${2:-}";  shift 2 ;;
    --action) action="${2:-}"; shift 2 ;;
    --label)  label="${2:-}";  shift 2 ;;
    --state)  state="${2:-}";  shift 2 ;;
    --number) number="${2:-}"; shift 2 ;;
    --repo)   repo="${2:-}";   shift 2 ;;
    *) shift ;;
  esac
done

# If the decision fields weren't passed, try a raw event payload (stdin or
# $GITHUB_EVENT_PATH). `action` only ever comes from the payload, so its absence is the
# signal to parse — even when --event was supplied (the event NAME is a header, not body).
if [ -z "$action" ]; then
  payload=""
  if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "${GITHUB_EVENT_PATH}" ]; then
    payload="$(cat "$GITHUB_EVENT_PATH")"
  elif [ ! -t 0 ]; then
    payload="$(cat)"
  fi
  if [ -n "$payload" ] && command -v jq >/dev/null 2>&1; then
    event="${event:-${GITHUB_EVENT_NAME:-}}"
    action="$(printf '%s' "$payload" | jq -r '.action // empty' 2>/dev/null)"
    label="$(printf '%s'  "$payload" | jq -r '.label.name // empty' 2>/dev/null)"
    state="$(printf '%s'  "$payload" | jq -r '.review.state // empty' 2>/dev/null)"
    number="$(printf '%s' "$payload" | jq -r '(.issue.number // .pull_request.number // .number) // empty' 2>/dev/null)"
    repo="$(printf '%s'   "$payload" | jq -r '.repository.full_name // empty' 2>/dev/null)"
  fi
fi

# Normalise review state to lowercase (GitHub sends e.g. "changes_requested" already,
# but be defensive).
state="$(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')"

route="none"
case "$event/$action" in
  issues/labeled)
    case "$label" in
      ready-for-ai) route="mcp-issue-loop" ;;
      auto-release) route="auto-release-loop" ;;
    esac ;;
  pull_request/labeled)
    [ "$label" = "auto-merge" ] && route="merge-flow" ;;
  pull_request_review/submitted)
    # changes_requested OR a plain "Comment" review (people batch actionable inline
    # comments under Comment far more than Request-changes). Approvals route nowhere;
    # rework-loop itself judges whether a comment review is actionable.
    case "$state" in changes_requested|commented) route="rework-loop" ;; esac ;;
esac

printf 'route=%s repo=%s number=%s\n' "$route" "$repo" "$number"
exit 0
