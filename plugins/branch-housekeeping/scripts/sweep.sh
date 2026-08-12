#!/usr/bin/env bash
#
# sweep.sh — classify every non-protected branch in every configured repo by its GitHub
# PR state, and print the Slack digest.
#
# Reads nothing but repos.conf and the GitHub API. Writes NOTHING to GitHub — this script
# is read-only, always. Deleting is reap.sh's job, and it re-verifies independently.
#
# PR state is the authoritative signal: these repos squash-merge, so a merged branch is
# NOT an ancestor of its base and `git branch --merged` misses it entirely.
#
# Deterministic: no prompts, no interpretation, same input → same output. Fails loudly.
#
# Requires: gh (authenticated), jq. Local-only by design — cloud routines have no gh.
#
# Usage:
#   sweep.sh [--out DIR] [OWNER/REPO ...]
#     no repos given → every repo in repos.conf (the normal weekly run)
#     --out DIR      → where the machine-readable lists go (default: a mktemp dir)
#
# A merged PR alone does NOT make a branch disposable — a recurring branch gets pushed to
# again after its PR merges. See "THE REUSE GUARD" below; it's the reason this script also
# tracks branch tip shas.
#
# Outputs:
#   stdout        the Slack digest, verbatim — relay it, don't re-summarise it
#   $OUT/merged.tsv   repo <TAB> branch <TAB> pr_number <TAB> branch_tip_sha  (reap.sh's input)
#   $OUT/review.tsv   repo <TAB> branch <TAB> reason <TAB> last_commit <TAB> link
#   $OUT/setting-off.tsv  repo                              (delete_branch_on_merge false)
#   $OUT/failed.tsv       repo                              (could not be read — a real gap)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/repos.conf"

BRANCH_CAP=200   # branches classified per repo; the remainder is reported, never silently dropped
PR_PAGES=5       # pages of 100 PRs pre-fetched to build the head→PR map (see references/sweep-config.md)

OUT=""
REPOS_ARG=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out needs a directory}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    -*) echo "sweep.sh: unknown option $1" >&2; exit 2 ;;
    *) REPOS_ARG+=("$1"); shift ;;
  esac
done

for c in gh jq; do
  command -v "$c" >/dev/null 2>&1 || { echo "sweep.sh: '$c' is required (local-only skill)" >&2; exit 1; }
done
gh auth status >/dev/null 2>&1 || { echo "sweep.sh: gh is not authenticated — run 'gh auth login'" >&2; exit 1; }

[ -n "$OUT" ] || OUT="$(mktemp -d)"
mkdir -p "$OUT"
: > "$OUT/merged.tsv"; : > "$OUT/review.tsv"; : > "$OUT/setting-off.tsv"
: > "$OUT/skipped.tsv"; : > "$OUT/failed.tsv"

# ---- resolve scope ----------------------------------------------------------------
# Each entry stays in the pipe-separated form from repos.conf so the protected list
# travels with its repo (bash 3.2 — no associative arrays).
ENTRIES=()
if [ ${#REPOS_ARG[@]} -gt 0 ]; then
  for r in "${REPOS_ARG[@]}"; do
    line="$(grep -E "^${r}\|" "$CONF" 2>/dev/null | head -1 || true)"
    # A repo named on the command line but absent from the config still gets swept, with
    # only the live guards. Better than refusing, and the digest says the list was empty.
    ENTRIES+=("${line:-${r}|}")
  done
else
  [ -f "$CONF" ] || { echo "sweep.sh: no repos.conf at $CONF" >&2; exit 1; }
  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    ENTRIES+=("$line")
  done < "$CONF"
fi
[ ${#ENTRIES[@]} -gt 0 ] || { echo "sweep.sh: empty scope — nothing configured to sweep" >&2; exit 1; }

KEPT_OPEN=0
FAILED_REPOS=()

for entry in "${ENTRIES[@]}"; do
  repo="${entry%%|*}"
  protected_csv="${entry#*|}"
  owner="${repo%%/*}"

  # Branch on the EXIT CODE, not output emptiness: `gh api` writes the error body to
  # stdout on failure, so a `-z` test treats {"message":…} as valid data.
  if ! meta="$(gh api "repos/$repo" --jq '{d:.default_branch, x:.delete_branch_on_merge, a:.archived}' 2>/dev/null)"; then
    FAILED_REPOS+=("$repo")
    continue
  fi
  default_branch="$(jq -r '.d' <<<"$meta")"
  dbom="$(jq -r '.x' <<<"$meta")"
  archived="$(jq -r '.a' <<<"$meta")"

  # An archived repo can't be acted on at all — findings there are pure noise.
  if [ "$archived" = "true" ]; then
    printf '%s\tarchived\n' "$repo" >> "$OUT/skipped.tsv"
    continue
  fi
  [ "$dbom" = "false" ] && printf '%s\n' "$repo" >> "$OUT/setting-off.tsv"

  # --paginate applies --jq per page, so the filter must iterate the page array itself;
  # jq -s then reassembles every page's objects into one array.
  # The tip sha is what makes the reuse guard possible — see the REUSED case below.
  branches_json="$(gh api "repos/$repo/branches" --paginate \
                    --jq '.[] | {name:.name, protected:.protected, sha:.commit.sha}' 2>/dev/null \
                    | jq -s '.' || true)"
  # jq -s always yields valid JSON, so check for a usable array rather than emptiness.
  if [ "$(jq 'if type=="array" then length else 0 end' <<<"$branches_json" 2>/dev/null || echo 0)" = "0" ]; then
    FAILED_REPOS+=("$repo")
    continue
  fi

  # Guard 1 (config) + guard 2 (live default branch) + guard 3 (live branch protection).
  # Space-padded string so a substring test is an exact whole-name match.
  protected_set=" $default_branch "
  [ -n "$protected_csv" ] && protected_set+="${protected_csv//,/ } "
  while IFS= read -r b; do
    [ -n "$b" ] && protected_set+="$b "
  done < <(jq -r '.[] | select(.protected==true) | .name' <<<"$branches_json")

  # One PR listing per repo → head→PR map. Newest-numbered PR wins per head.
  # Field 5 is the PR's head sha, frozen at the last push to that PR. Once the PR is
  # closed it stops tracking the branch, which is exactly what lets us detect reuse.
  prmap="$OUT/.prs-$(echo "$repo" | tr '/' '_').tsv"
  gh api "repos/$repo/pulls?state=all&sort=updated&direction=desc&per_page=100" \
    --paginate --jq '.[] | [.head.ref, (.number|tostring), .state, (.merged_at // "null"), .head.sha, .base.ref] | @tsv' \
    2>/dev/null | head -n $((PR_PAGES * 100)) | sort -t"$(printf '\t')" -k2,2nr > "$prmap" || true

  total=0; classified=0
  while IFS=$'\t' read -r branch branch_sha; do
    [ -z "$branch" ] && continue
    total=$((total + 1))
    case "$protected_set" in *" $branch "*) continue ;; esac
    if [ "$classified" -ge "$BRANCH_CAP" ]; then continue; fi
    classified=$((classified + 1))

    row="$(awk -F'\t' -v b="$branch" '$1==b {print; exit}' "$prmap")"
    # Not in the pre-fetched window → ask GitHub directly for this head.
    # The `length==0 then empty` guard is load-bearing: max_by on an empty array yields
    # null, and `null.number | tostring` emits the literal string "null" — which would
    # sail through as a real PR numbered "null" and misfile a no-PR branch as CLOSED.
    if [ -z "$row" ]; then
      row="$(gh api "repos/$repo/pulls?head=${owner}:${branch}&state=all&per_page=100" \
              --jq 'if length==0 then empty else (max_by(.number) | [.head.ref, (.number|tostring), .state, (.merged_at // "null"), .head.sha, .base.ref] | @tsv) end' \
              2>/dev/null || true)"
    fi

    if [ -z "$row" ]; then
      state="NONE"; pr_num=""; pr_head_sha=""; pr_base=""
    else
      pr_num="$(cut -f2 <<<"$row")"
      pr_state="$(cut -f3 <<<"$row")"
      pr_merged="$(cut -f4 <<<"$row")"
      pr_head_sha="$(cut -f5 <<<"$row")"
      pr_base="$(cut -f6 <<<"$row")"
      if [ "$pr_state" = "open" ]; then state="OPEN"
      elif [ "$pr_merged" != "null" ] && [ -n "$pr_merged" ]; then state="MERGED"
      else state="CLOSED"; fi
    fi

    # THE REUSE GUARD. "Its newest PR is merged" does NOT mean "this branch is
    # disposable": a recurring branch (chore/merge-main-to-dev, merge/v17-*) gets pushed
    # to again after its PR merges, so it can hold commits that were never merged
    # anywhere. A containment check can't tell the difference, because a legitimately
    # squash-merged branch is also not an ancestor of its base — that's why this whole
    # skill reads PR state in the first place. The precise signal is the sha: a closed
    # PR's head.sha is frozen at what it actually merged, so tip != head.sha means the
    # branch moved on afterwards. Demote to review; never delete.
    if [ "$state" = "MERGED" ] && [ -n "$pr_head_sha" ] && [ -n "$branch_sha" ] \
       && [ "$branch_sha" != "$pr_head_sha" ]; then
      state="REUSED"
    fi

    case "$state" in
      OPEN)
        KEPT_OPEN=$((KEPT_OPEN + 1))
        ;;
      MERGED)
        printf '%s\t%s\t%s\t%s\n' "$repo" "$branch" "$pr_num" "$branch_sha" >> "$OUT/merged.tsv"
        ;;
      REUSED|CLOSED|NONE)
        last="$(gh api "repos/$repo/branches/$branch" \
                 --jq '.commit.commit.committer.date' 2>/dev/null | cut -c1-10 || true)"
        # Must look like YYYY-MM-DD; a vanished branch or an error body yields junk.
        case "$last" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) last="unknown" ;; esac
        case "$state" in
          REUSED)
            # How far it has diverged is the number a human needs to judge it.
            # Compare against the PR's OWN base, not the repo default: these PRs target
            # dev or v17/dev, so measuring against main reports a number for the wrong branch.
            cmp_base="${pr_base:-$default_branch}"
            ahead="$(gh api "repos/$repo/compare/${cmp_base}...${branch}" \
                      --jq '.ahead_by' 2>/dev/null || true)"
            [ -n "$ahead" ] || ahead="?"
            reason="PR #$pr_num merged BUT branch reused since (${ahead} commit(s) not in $cmp_base) — NOT deleted"
            link="https://github.com/$repo/compare/${cmp_base}...${branch}"
            ;;
          CLOSED)
            reason="PR #$pr_num closed unmerged"
            link="https://github.com/$repo/pull/$pr_num"
            ;;
          *)
            reason="no PR found"
            link="https://github.com/$repo/tree/$branch"
            ;;
        esac
        printf '%s\t%s\t%s\t%s\t%s\n' "$repo" "$branch" "$reason" "$last" "$link" >> "$OUT/review.tsv"
        ;;
    esac
  done < <(jq -r '.[] | [.name, .sha] | @tsv' <<<"$branches_json")

  # A cap that silently truncates reads as "covered everything" when it didn't.
  uncapped=$((total - classified))
  if [ "$classified" -ge "$BRANCH_CAP" ] && [ "$uncapped" -gt 0 ]; then
    printf '%s\tcap\t%s\n' "$repo" "$uncapped" >> "$OUT/skipped.tsv"
  fi
done

# ---- the digest --------------------------------------------------------------------
n_merged=$(wc -l < "$OUT/merged.tsv" | tr -d ' ')
n_review=$(wc -l < "$OUT/review.tsv" | tr -d ' ')
n_setoff=$(wc -l < "$OUT/setting-off.tsv" | tr -d ' ')
today=$(date -u +%Y-%m-%d)

printf ':broom: *Umbraco MCP branch housekeeping* — %s\n' "$today"

printf '\n*Repos missing "Automatically delete head branches": %s*\n' "$n_setoff"
if [ "$n_setoff" -gt 0 ]; then
  while IFS= read -r r; do
    printf '• %s — turn it on: Settings → General → Pull Requests\n' "$r"
  done < "$OUT/setting-off.tsv"
else
  printf '• none — all swept repos reap merged branches at merge time :tada:\n'
fi

printf '\n*Merged — safe to delete, work already in mainline: %s*\n' "$n_merged"
if [ "$n_merged" -gt 0 ]; then
  while IFS=$'\t' read -r r b n; do
    printf '• %s  `%s`  (PR #%s)\n' "$r" "$b" "$n"
  done < "$OUT/merged.tsv"
else
  printf '• none\n'
fi

printf '\n*Needs review — never auto-actioned: %s*\n' "$n_review"
if [ "$n_review" -gt 0 ]; then
  while IFS=$'\t' read -r r b reason last link; do
    printf '• <%s|%s@%s> — %s, last commit %s\n' "$link" "$r" "$b" "$reason" "$last"
  done < "$OUT/review.tsv"
else
  printf '• none :tada:\n'
fi

printf '\n_Kept %s branch(es) with open PRs untouched._\n' "$KEPT_OPEN"

if [ -s "$OUT/skipped.tsv" ]; then
  printf '\n*Not fully covered:*\n'
  while IFS=$'\t' read -r r kind n; do
    case "$kind" in
      archived) printf '• %s — archived, skipped\n' "$r" ;;
      cap)      printf '• %s — %s branch(es) past the %s cap, NOT classified\n' "$r" "$n" "$BRANCH_CAP" ;;
    esac
  done < "$OUT/skipped.tsv"
fi

if [ ${#FAILED_REPOS[@]} -gt 0 ]; then
  printf '\n*Could not read (gap in this sweep):*\n'
  for r in "${FAILED_REPOS[@]}"; do
    printf '• %s\n' "$r"
    # Machine-readable too: a caller that only consumes merged.tsv (reap.sh) would
    # otherwise read an unreadable repo as "nothing to do" — a typo'd repo name must
    # not look like success.
    printf '%s\n' "$r" >> "$OUT/failed.tsv"
  done
fi

printf '\nOUT=%s\n' "$OUT" >&2
