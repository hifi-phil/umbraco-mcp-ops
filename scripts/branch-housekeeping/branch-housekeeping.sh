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
# Requires: gh (authenticated), jq, curl.
# Env: SLACK_WEBHOOK_URL (optional extra delivery). The summary is always printed to
#      stdout, so a routine can relay it to Slack via the Claude integration instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=../../lib/slack.sh
source "$REPO_ROOT/lib/slack.sh"
# shellcheck source=./housekeeping.config
source "$SCRIPT_DIR/housekeeping.config"

DRY_RUN=true
case "${1:-}" in
  --live)    DRY_RUN=false ;;
  --dry-run) DRY_RUN=true ;;
  "")        DRY_RUN=true ;;
  *) echo "Usage: $0 [--live|--dry-run]" >&2; exit 2 ;;
esac

for cmd in gh jq curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: '$cmd' is required but not installed." >&2; exit 1; }
done

# Accumulators for the final report.
declare -a DELETED=()      # "repo  branch  (PR #n)"
declare -a WOULD_DELETE=() # dry-run equivalent of DELETED
declare -a REVIEW=()       # "repo  branch  reason  last-commit  PR-link"
KEPT_COUNT=0

mode_label() { $DRY_RUN && echo "DRY-RUN (no deletions)" || echo "LIVE"; }

echo "== Branch housekeeping — $(mode_label) =="

for entry in "${HOUSEKEEPING_REPOS[@]}"; do
  repo="${entry%%|*}"
  protected_csv="${entry#*|}"

  echo ""
  echo "Repo: $repo"

  # Build the protected set: configured list + default branch + GitHub-protected.
  # Kept as a space-padded string for bash 3.2 portability (no associative arrays).
  default_branch="$(gh repo view "$repo" --json defaultBranchRef --jq '.defaultBranchRef.name')"

  protected_set=" $default_branch "
  protected_set+="${protected_csv//,/ } "
  while IFS= read -r b; do
    [[ -n "$b" ]] && protected_set+="$b "
  done < <(gh api --paginate "repos/$repo/branches?per_page=100" --jq '.[] | select(.protected==true) | .name')

  # Walk every branch.
  while IFS= read -r branch; do
    [[ -z "$branch" ]] && continue
    if [[ "$protected_set" == *" $branch "* ]]; then
      continue
    fi

    pr_json="$(gh pr list --repo "$repo" --head "$branch" --state all \
                 --json state,number,url --jq 'max_by(.number) // empty' 2>/dev/null || true)"

    if [[ -z "$pr_json" ]]; then
      state="NONE"; pr_num=""; pr_url=""
    else
      state="$(jq -r '.state' <<< "$pr_json")"
      pr_num="$(jq -r '.number' <<< "$pr_json")"
      pr_url="$(jq -r '.url' <<< "$pr_json")"
    fi

    case "$state" in
      MERGED)
        if $DRY_RUN; then
          WOULD_DELETE+=("$repo  $branch  (PR #$pr_num)")
          echo "  [would delete] $branch (PR #$pr_num merged)"
        else
          if gh api -X DELETE "repos/$repo/git/refs/heads/$branch" >/dev/null 2>&1; then
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
        last_commit="$(gh api "repos/$repo/branches/$branch" \
                        --jq '.commit.commit.committer.date' 2>/dev/null | cut -c1-10)"
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
  done < <(gh api --paginate "repos/$repo/branches?per_page=100" --jq '.[].name')
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
