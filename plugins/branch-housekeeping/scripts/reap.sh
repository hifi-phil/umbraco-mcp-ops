#!/usr/bin/env bash
#
# reap.sh — delete the remote branches sweep.sh classified as MERGED.
#
# This is the only destructive step in the skill, so it does not trust its input:
# every branch is INDEPENDENTLY re-verified against the GitHub API immediately before
# deletion, and re-checked against repos.conf's protected list plus the repo's live
# default branch and live branch protection. A stale merged.tsv therefore cannot cause
# a wrong delete — it can only cause a skip.
#
# Deterministic and idempotent: 204 (deleted) and 404 (already gone) are both success.
#
# Requires: gh (authenticated), jq. Local-only — cloud routines have no gh, and the
# GitHub MCP server exposes no branch-delete tool at all.
#
# Usage:
#   reap.sh --list DIR/merged.tsv [--dry-run]
#     --dry-run  verify everything and print what would happen, delete nothing
#
# Exit: 0 if every candidate was deleted, already gone, or safely skipped;
#       1 if any delete was attempted and failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/repos.conf"

LIST=""
DRY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST="${2:?--list needs a file}"; shift 2 ;;
    --dry-run) DRY=true; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "reap.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

[ -n "$LIST" ] || { echo "reap.sh: --list DIR/merged.tsv is required" >&2; exit 2; }
[ -f "$LIST" ] || { echo "reap.sh: no such list: $LIST" >&2; exit 2; }

for c in gh jq; do
  command -v "$c" >/dev/null 2>&1 || { echo "reap.sh: '$c' is required (local-only skill)" >&2; exit 1; }
done
gh auth status >/dev/null 2>&1 || { echo "reap.sh: gh is not authenticated — run 'gh auth login'" >&2; exit 1; }

if [ ! -s "$LIST" ]; then
  echo "reap.sh: nothing to reap (list is empty)"
  exit 0
fi

deleted=0; already=0; skipped=0; failed=0

# sweep.sh writes 4 columns; read all of them or the last variable swallows the rest of the
# line. sweep's sha is informational only — the guards below re-fetch their own.
while IFS=$'\t' read -r repo branch pr _sweep_sha; do
  [ -z "${repo:-}" ] || [ -z "${branch:-}" ] && continue

  # --- guard: protected list from repos.conf ---
  csv="$(grep -E "^${repo}\|" "$CONF" 2>/dev/null | head -1 | sed 's/^[^|]*|//' || true)"
  prot=" "
  [ -n "$csv" ] && prot+="${csv//,/ } "

  # --- guard: live default branch + live branch protection ---
  # Same exit-code rule as the branch lookup below — an error body is not data.
  if ! meta="$(gh api "repos/$repo" --jq '{d:.default_branch, a:.archived}' 2>/dev/null)"; then
    echo "  SKIP  $repo  $branch  — cannot read repo metadata"
    skipped=$((skipped + 1)); continue
  fi
  [ "$(jq -r '.a' <<<"$meta")" = "true" ] && {
    echo "  SKIP  $repo  $branch  — repo archived"
    skipped=$((skipped + 1)); continue
  }
  prot+="$(jq -r '.d' <<<"$meta") "

  case "$prot" in *" $branch "*)
    echo "  SKIP  $repo  $branch  — PROTECTED (config or default branch)"
    skipped=$((skipped + 1)); continue ;;
  esac

  # Branch on the EXIT CODE, not on output emptiness: `gh api` prints the error body to
  # stdout on a 404, so `[ -z "$out" ]` never fires and the JSON ({"message":…) gets read
  # as a sha. That made a second run misreport an already-deleted branch as REUSED.
  if ! binfo="$(gh api "repos/$repo/branches/$branch" --jq '[.protected, .commit.sha] | @tsv' 2>/dev/null)"; then
    echo "  GONE  $repo  $branch  — branch no longer exists"
    already=$((already + 1)); continue
  fi
  b_protected="$(cut -f1 <<<"$binfo")"
  b_sha="$(cut -f2 <<<"$binfo")"
  if [ "$b_protected" = "true" ]; then
    echo "  SKIP  $repo  $branch  — GitHub branch protection is on"
    skipped=$((skipped + 1)); continue
  fi

  # --- guard: re-verify MERGED independently of the list ---
  owner="${repo%%/*}"
  # `length==0 then empty` matters: max_by on an empty array yields null, and the
  # stringified nulls would read as a real merged PR. An empty verdict must mean "no PR".
  verdict="$(gh api "repos/$repo/pulls?head=${owner}:${branch}&state=all&per_page=100" \
              --jq 'if length==0 then empty else (max_by(.number) | [(.number|tostring), .state, (.merged_at // "null"), .head.sha] | @tsv) end' \
              2>/dev/null || true)"
  if [ -z "$verdict" ]; then
    echo "  SKIP  $repo  $branch  — no PR found now (list is stale); left for review"
    skipped=$((skipped + 1)); continue
  fi
  v_state="$(cut -f2 <<<"$verdict")"
  v_merged="$(cut -f3 <<<"$verdict")"
  v_head_sha="$(cut -f4 <<<"$verdict")"
  if [ "$v_state" = "open" ] || [ "$v_merged" = "null" ] || [ -z "$v_merged" ]; then
    echo "  SKIP  $repo  $branch  — not merged on re-check (state=$v_state); left alone"
    skipped=$((skipped + 1)); continue
  fi

  # --- guard: the branch must not have been REUSED since its PR merged ---
  # A merged PR does not make the branch disposable: recurring branches get pushed to
  # again afterwards and can hold commits that were never merged anywhere. A closed PR's
  # head.sha is frozen at what it merged, so tip != head.sha means new work. Deleting
  # here would destroy it, and this is the last line of defence, so check independently.
  if [ -n "$v_head_sha" ] && [ -n "$b_sha" ] && [ "$b_sha" != "$v_head_sha" ]; then
    echo "  SKIP  $repo  $branch  — REUSED since PR #$pr merged (tip ${b_sha:0:7} != merged ${v_head_sha:0:7}); left for review"
    skipped=$((skipped + 1)); continue
  fi

  if $DRY; then
    echo "  WOULD $repo  $branch  (PR #$pr merged, re-verified)"
    continue
  fi

  # Don't parse status headers — just ask whether the ref survived. That reads the same
  # for a 204 and for a delete that raced with someone else's, which is what idempotent means.
  if gh api -X DELETE "repos/$repo/git/refs/heads/$branch" >/dev/null 2>&1; then
    echo "  DEL   $repo  $branch  (PR #$pr)"; deleted=$((deleted + 1))
  elif ! gh api "repos/$repo/branches/$branch" >/dev/null 2>&1; then
    echo "  GONE  $repo  $branch  — already absent"; already=$((already + 1))
  else
    echo "  FAIL  $repo  $branch  — delete rejected, branch still present"; failed=$((failed + 1))
  fi
done < "$LIST"

echo
if $DRY; then
  echo "reap.sh --dry-run: nothing deleted. skipped=$skipped already-gone=$already"
else
  echo "reap.sh: deleted=$deleted already-gone=$already skipped=$skipped failed=$failed"
fi
[ "$failed" -eq 0 ] || exit 1
