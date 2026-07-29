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
#      issue_comment only: --issue-labels --issue-state --author-type --author-assoc
#                          --self-marked --is-pr
#   2. a raw GitHub event JSON on stdin or at $GITHUB_EVENT_PATH (parsed with jq);
#      the event NAME comes from --event or $GITHUB_EVENT_NAME (it's an HTTP header,
#      not part of the JSON body).
#
# Output: one line of `key=value` pairs on stdout, always exit 0:
#   route=<mcp-issue-loop|auto-release-loop|merge-flow|rework-loop|issue-discuss-loop|none> repo=<r> number=<n>
# route=none means "not ours — quiet no-op". `none` is a normal outcome, not an error.
#
# Unknown / missing / unmatched fields always resolve to route=none. It never guesses.
set -uo pipefail

event="" action="" label="" state="" number="" repo=""
issue_labels="" issue_state="" author_type="" author_assoc="" self_marked="" is_pr=""

# The marker the discussion loop signs every comment with. Matched as a PREFIX so the
# variants (e.g. `<!-- issue-discuss-loop:capped -->`) match too.
DISCUSS_MARKER="<!-- issue-discuss-loop"

while [ $# -gt 0 ]; do
  case "$1" in
    --event)  event="${2:-}";  shift 2 ;;
    --action) action="${2:-}"; shift 2 ;;
    --label)  label="${2:-}";  shift 2 ;;
    --state)  state="${2:-}";  shift 2 ;;
    --number) number="${2:-}"; shift 2 ;;
    --repo)   repo="${2:-}";   shift 2 ;;
    # issue_comment only. The comment payload has no `.label`, so a discussion round is
    # matched on the issue's own labels + state, the commenter's type/association, and
    # whether the comment carries the loop's marker (i.e. the loop wrote it).
    --issue-labels) issue_labels="${2:-}"; shift 2 ;;
    --issue-state)  issue_state="${2:-}";  shift 2 ;;
    --author-type)  author_type="${2:-}";  shift 2 ;;
    --author-assoc) author_assoc="${2:-}"; shift 2 ;;
    --self-marked)  self_marked="${2:-}";  shift 2 ;;
    --is-pr)        is_pr="${2:-}";        shift 2 ;;
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
    # issue_comment: no `.label` in the payload, so read the issue's own labels + state, the
    # commenter's type and association, and whether the body carries the loop's marker.
    issue_labels="$(printf '%s' "$payload" | jq -r '[.issue.labels[]?.name] | join(",")' 2>/dev/null)"
    issue_state="$(printf '%s'  "$payload" | jq -r '.issue.state // empty' 2>/dev/null)"
    author_type="$(printf '%s'  "$payload" | jq -r '.comment.user.type // empty' 2>/dev/null)"
    author_assoc="$(printf '%s' "$payload" | jq -r '.comment.author_association // empty' 2>/dev/null)"
    self_marked="$(printf '%s'  "$payload" | jq -r --arg m "$DISCUSS_MARKER" \
      'if ((.comment.body // "") | contains($m)) then "1" else empty end' 2>/dev/null)"
    # `.issue.pull_request` is present only when the comment is on a PR (GitHub sends PR
    # conversation comments as issue_comment too).
    is_pr="$(printf '%s' "$payload" | jq -r 'if .issue.pull_request then "1" else empty end' 2>/dev/null)"
  fi
fi

# Normalise review state to lowercase (GitHub sends e.g. "changes_requested" already,
# but be defensive).
state="$(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')"

# The PR-label triggers use `pull_request_target` (it runs from the base repo's DEFAULT
# branch with secrets, regardless of the PR's base — so it fires for our dev-based loop
# PRs, which plain `pull_request` does not). It carries the same payload, so treat it as
# `pull_request` for routing.
[ "$event" = "pull_request_target" ] && event="pull_request"

# Only an explicit truthy value means "this is a PR" — so `--is-pr 0` reads as "not a PR",
# not as "PR" (which bare emptiness-testing would get backwards).
case "$is_pr" in 1|true|yes) is_pr=1 ;; *) is_pr="" ;; esac

# labels_include <list> <name> — does a comma/newline-separated list carry this exact label?
# Wrapped in commas so a substring (`ai-discussion`) can't match. Whitespace is stripped so a
# newline-separated list works; the labels tested here never contain spaces.
labels_include() {
  case ",${1//[[:space:]]/}," in *,"$2",*) return 0 ;; esac
  return 1
}

# is_trusted <author_association> — is the commenter someone who may drive a loop?
# Anything else (NONE, CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, empty, unknown) is untrusted.
is_trusted() {
  case "$1" in OWNER|MEMBER|COLLABORATOR) return 0 ;; esac
  return 1
}

route="none"
case "$event/$action" in
  issues/labeled)
    case "$label" in
      ready-for-ai) route="mcp-issue-loop" ;;
      auto-release) route="auto-release-loop" ;;
      ai-discuss)   route="issue-discuss-loop" ;;
    esac ;;
  pull_request/labeled)
    case "$label" in
      auto-merge)  route="merge-flow" ;;
      auto-rework) route="rework-loop" ;;
    esac ;;
  issue_comment/created)
    # A discussion round — the next reply in an `ai-discuss` conversation.
    #
    # THE LOOP POSTS AS THE MAINTAINER'S OWN ACCOUNT. Verified: every loop-authored issue and
    # comment on the ops repo is `hifi-phil`, `type: "User"`, `OWNER` — the same thing
    # merge-flow and rework-loop already say about loop-authored PRs ("often yours"). So the
    # author fields CANNOT distinguish the loop's own reply from a human's, and an
    # author-identity guard would let the loop answer itself round after round. Instead the
    # loop SIGNS every comment with `<!-- issue-discuss-loop -->` and this gate skips signed
    # comments. That works the same in cloud and local runs, whoever the account is.
    #
    # Five gates, all required, all fail-closed (a missing/unknown field routes nowhere):
    #   1. the issue carries `ai-discuss` — the label IS "the conversation is open"
    #   2. the comment is NOT signed by the loop — the anti-self-reply guard
    #   3. the commenter is trusted (OWNER / MEMBER / COLLABORATOR). These repos are public:
    #      without this, any GitHub user could burn a cloud session — or steer a rewrite of
    #      the issue body — just by commenting.
    #   4. the issue is still open
    #   5. it's an issue, not a PR (GitHub sends PR conversation comments as issue_comment)
    if labels_include "$issue_labels" ai-discuss \
       && [ -z "$self_marked" ] \
       && is_trusted "$author_assoc" \
       && [ "$author_type" = "User" ] \
       && [ "$issue_state" = "open" ] \
       && [ -z "$is_pr" ]; then
      route="issue-discuss-loop"
    fi ;;
esac

printf 'route=%s repo=%s number=%s\n' "$route" "$repo" "$number"
exit 0
