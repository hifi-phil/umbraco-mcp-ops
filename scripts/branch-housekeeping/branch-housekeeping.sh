#!/usr/bin/env bash
#
# Weekly remote-branch housekeeping for the Umbraco MCP repos.
#
# For each configured repo it classifies every non-protected branch by its
# GitHub PR state (the authoritative signal — squash merges make git ancestry
# lie) and acts:
#
#   MERGED PR            -> delete the branch (work is already in mainline)
#   OPEN PR              -> keep, silently (active work, incl. dependabot)
#   CLOSED-unmerged / no PR -> leave alone, report to Slack for a human to check
#
# Protected branches (configured list + repo default + GitHub-protected) are
# never touched.
#
# Default mode is DRY-RUN: it reports what it *would* delete without deleting.
# Pass --live to actually delete.
#
# Requires: curl, jq, and a GH_TOKEN env var with access to the configured
#   repos (pull_requests/metadata read to classify, contents write to delete).
#   The GitHub CLI (gh) is intentionally NOT required: Claude Code on the web
#   runners ship curl+jq but not gh, and a usable token is already injected as
#   GH_TOKEN. The script therefore talks to the GitHub REST API directly.
# Env: SLACK_WEBHOOK_URL (optional extra delivery). The summary is always printed to
#      stdout, so a routine can relay it to Slack via the Claude integration instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=../../lib/slack.sh
source "$REPO_ROOT/lib/slack.sh"
# shellcheck source=./housekeeping.config
source "$SCRIPT_DIR/housekeeping.config"

API="${GITHUB_API_URL:-https://api.github.com}"

DRY_RUN=true
case "${1:-}" in
  --live)    DRY_RUN=false ;;
  --dry-run) DRY_RUN=true ;;
  "")        DRY_RUN=true ;;
  *) echo "Usage: $0 [--live|--dry-run]" >&2; exit 2 ;;
esac

for cmd in curl jq; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: '$cmd' is required but not installed." >&2; exit 1; }
done
[[ -n "${GH_TOKEN:-}" ]] || { echo "ERROR: GH_TOKEN is not set (needed to authenticate to the GitHub API)." >&2; exit 1; }

# ---- GitHub REST helpers -----------------------------------------------------
# api METHOD PATH -> prints response body on stdout; returns non-zero on HTTP>=400.
api() {
  local method="$1" path="$2" resp code body
  resp="$(curl -sS -w $'\n%{http_code}' -X "$method" \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${API}${path}")" || return 1
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  if (( code >= 400 )); then
    echo "API ${method} ${path} -> HTTP ${code}: $(jq -r '.message // empty' <<<"$body" 2>/dev/null)" >&2
    return 1
  fi
  printf '%s' "$body"
}

# api_code METHOD PATH -> prints only the HTTP status code (for idempotent deletes).
api_code() {
  local method="$1" path="$2"
  curl -sS -o /dev/null -w '%{http_code}' -X "$method" \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${API}${path}"
}

# all_branches_json REPO -> prints one JSON array of every branch (all pages).
all_branches_json() {
  local repo="$1" page=1 chunk acc='[]'
  while :; do
    chunk="$(api GET "/repos/${repo}/branches?per_page=100&page=${page}")" || return 1
    [[ "$(jq 'length' <<<"$chunk")" -eq 0 ]] && break
    acc="$(jq -s 'add' <(printf '%s' "$acc") <(printf '%s' "$chunk"))"
    page=$((page + 1))
  done
  printf '%s' "$acc"
}

# Accumulators for the final report.
declare -a DELETED=()      # "repo  branch  (PR #n)"
declare -a WOULD_DELETE=() # dry-run equivalent of DELETED
declare -a REVIEW=()       # "repo|branch|reason|last-commit|PR-link"
KEPT_COUNT=0

mode_label() { $DRY_RUN && echo "DRY-RUN (no deletions)" || echo "LIVE"; }

echo "== Branch housekeeping — $(mode_label) =="

for entry in "${HOUSEKEEPING_REPOS[@]}"; do
  repo="${entry%%|*}"
  protected_csv="${entry#*|}"
  owner="${repo%%/*}"

  echo ""
  echo "Repo: $repo"

  branches_json="$(all_branches_json "$repo")" || { echo "  ERROR: cannot list branches, skipping repo"; continue; }

  # Build the protected set: configured list + default branch + GitHub-protected.
  # Kept as a space-padded string for bash 3.2 portability (no associative arrays).
  default_branch="$(api GET "/repos/$repo" | jq -r '.default_branch')"

  protected_set=" $default_branch "
  protected_set+="${protected_csv//,/ } "
  while IFS= read -r b; do
    [[ -n "$b" ]] && protected_set+="$b "
  done < <(jq -r '.[] | select(.protected==true) | .name' <<<"$branches_json")

  # Walk every branch.
  while IFS= read -r branch; do
    [[ -z "$branch" ]] && continue
    if [[ "$protected_set" == *" $branch "* ]]; then
      continue
    fi

    # Most recent PR with this branch as head, across all states.
    pr_json="$(api GET "/repos/$repo/pulls?head=${owner}:${branch}&state=all&per_page=100" \
                 | jq 'max_by(.number) // empty' 2>/dev/null || true)"

    if [[ -z "$pr_json" ]]; then
      state="NONE"; pr_num=""; pr_url=""
    else
      pr_num="$(jq -r '.number' <<<"$pr_json")"
      pr_url="$(jq -r '.html_url' <<<"$pr_json")"
      pr_state="$(jq -r '.state' <<<"$pr_json")"
      pr_merged="$(jq -r '.merged_at // "null"' <<<"$pr_json")"
      if [[ "$pr_state" == "open" ]]; then
        state="OPEN"
      elif [[ "$pr_merged" != "null" ]]; then
        state="MERGED"
      else
        state="CLOSED"
      fi
    fi

    case "$state" in
      MERGED)
        if $DRY_RUN; then
          WOULD_DELETE+=("$repo  $branch  (PR #$pr_num)")
          echo "  [would delete] $branch (PR #$pr_num merged)"
        else
          if [[ "$(api_code DELETE "/repos/$repo/git/refs/heads/$branch")" == "204" ]]; then
            DELETED+=("$repo  $branch  (PR #$pr_num)")
            echo "  [deleted] $branch (PR #$pr_num merged)"
          else
            # 404 => already gone (idempotent); anything else => flag for review.
            DELETED+=("$repo  $branch  (PR #$pr_num — already absent)")
            echo "  [already gone] $branch"
          fi
        fi
        ;;
      OPEN)
        KEPT_COUNT=$((KEPT_COUNT + 1))
        ;;
      CLOSED|NONE)
        last_commit="$(api GET "/repos/$repo/branches/$branch" \
                        | jq -r '.commit.commit.committer.date' 2>/dev/null | cut -c1-10)"
        [[ -z "$last_commit" ]] && last_commit="unknown"
        if [[ "$state" == "CLOSED" ]]; then
          reason="PR #$pr_num closed unmerged"
          link="$pr_url"
        else
          reason="no PR found"
          link="https://github.com/$repo/tree/$branch"
        fi
        REVIEW+=("$repo|$branch|$reason|$last_commit|$link")
        echo "  [review] $branch — $reason (last commit $last_commit)"
        ;;
    esac
  done < <(jq -r '.[].name' <<<"$branches_json")
done

# ---- Build the Slack / stdout summary ----------------------------------------

if $DRY_RUN; then
  del_items=( "${WOULD_DELETE[@]+"${WOULD_DELETE[@]}"}" )
  del_header="Would delete (merged → already in mainline)"
else
  del_items=( "${DELETED[@]+"${DELETED[@]}"}" )
  del_header="Deleted (merged → already in mainline)"
fi

summary=":broom: *Umbraco MCP branch housekeeping* — $(mode_label)"

summary+=$'\n\n'"*$del_header: ${#del_items[@]}*"
if (( ${#del_items[@]} > 0 )); then
  for line in "${del_items[@]}"; do
    summary+=$'\n'"• ${line}"
  done
fi

summary+=$'\n\n'"*Needs review (no auto-action): ${#REVIEW[@]}*"
if (( ${#REVIEW[@]} > 0 )); then
  for item in "${REVIEW[@]}"; do
    IFS='|' read -r r b reason last link <<< "$item"
    summary+=$'\n'"• <${link}|${r}@${b}> — ${reason}, last commit ${last}"
  done
else
  summary+=$'\n'"• none :tada:"
fi

summary+=$'\n\n'"_Kept ${KEPT_COUNT} branch(es) with open PRs untouched._"

echo ""
echo "== Summary =="
echo "$summary"
post_to_slack "$summary"   # extra delivery if SLACK_WEBHOOK_URL is set; otherwise relay this stdout to Slack

echo ""
echo "Done."
