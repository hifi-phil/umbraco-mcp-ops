#!/usr/bin/env bash
#
# reap.sh — delete the remote branches whose PR was merged and which have not been
# touched since. Run it only when you want branches gone; nothing schedules it.
#
# Self-contained: with no --list it runs sweep.sh itself to build a FRESH candidate list,
# so cleaning is one command with no plumbing. Pass --list to reuse an existing sweep.
#
# Purely mechanical — no interpretation, no judgement, no LLM in the loop. Same input,
# same actions, every time.
#
# It does not trust its input. Every branch is INDEPENDENTLY re-verified against the
# GitHub API immediately before deletion: repos.conf's protected list, the repo's live
# default branch, live branch protection, that its newest PR really is merged, and that
# the branch tip still matches what that PR merged. A stale list can only cause a skip.
#
# Idempotent: deleted and already-gone are both success.
#
# Requires: gh (authenticated), jq. Local-only — the GitHub MCP server exposes no
# branch-delete tool, so this cannot run in a cloud routine.
#
# Usage:
#   reap.sh [--dry-run] [OWNER/REPO ...]      sweep fresh, then delete
#   reap.sh --list DIR/merged.tsv [--dry-run] use a list sweep.sh already produced
#     --dry-run  run every check and print what would happen, delete nothing
#     OWNER/REPO limit the fresh sweep to those repos (default: all of repos.conf)
#
# Exit: 0 if every candidate was deleted, already gone, or safely skipped;
#       1 if any delete was attempted and failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/repos.conf"

LIST=""
DRY=false
REPOS_ARG=()
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST="${2:?--list needs a file}"; shift 2 ;;
    --dry-run) DRY=true; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    -*) echo "reap.sh: unknown option $1" >&2; exit 2 ;;
    *) REPOS_ARG+=("$1"); shift ;;
  esac
done

for c in gh jq; do
  command -v "$c" >/dev/null 2>&1 || { echo "reap.sh: '$c' is required (local-only)" >&2; exit 1; }
done
gh auth status >/dev/null 2>&1 || { echo "reap.sh: gh is not authenticated — run 'gh auth login'" >&2; exit 1; }

# No list given → sweep now. A fresh sweep is the safer default anyway: the older a list
# is, the more likely a branch has been reused since it was written.
if [ -z "$LIST" ]; then
  SWEEP_OUT="$(mktemp -d)"
  sweep_log="$SWEEP_OUT/sweep.stderr"
  echo "reap.sh: sweeping fresh for candidates..." >&2
  # Hold the sweep's own chatter back, but surface it if the sweep actually fails —
  # a silent classification failure would look like "nothing to clean".
  if ! "$SCRIPT_DIR/sweep.sh" --out "$SWEEP_OUT" ${REPOS_ARG[@]+"${REPOS_ARG[@]}"} \
        >/dev/null 2>"$sweep_log"; then
    echo "reap.sh: the sweep failed — refusing to delete anything. Its output:" >&2
    sed 's/^/  /' "$sweep_log" >&2
    exit 1
  fi
  LIST="$SWEEP_OUT/merged.tsv"
  # An unreadable repo is a gap, not an absence. Without this, a typo'd repo name sweeps
  # nothing, finds no candidates, and exits 0 — reading as "already clean".
  if [ -s "$SWEEP_OUT/failed.tsv" ]; then
    echo "reap.sh: WARNING — could not read these repo(s), so they were NOT considered:" >&2
    sed 's/^/  /' "$SWEEP_OUT/failed.tsv" >&2
    if [ ! -s "$LIST" ]; then
      echo "reap.sh: nothing was readable and nothing to reap — check the repo name(s)." >&2
      exit 1
    fi
  fi
  echo "reap.sh: $(wc -l < "$LIST" | tr -d ' ') candidate(s) found" >&2
elif [ ${#REPOS_ARG[@]} -gt 0 ]; then
  echo "reap.sh: --list and OWNER/REPO are mutually exclusive (the list already fixes the scope)" >&2
  exit 2
fi

[ -f "$LIST" ] || { echo "reap.sh: no such list: $LIST" >&2; exit 2; }

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
