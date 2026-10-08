#!/usr/bin/env bash
#
# Tests for push-branch.sh against a throwaway local "origin" (a bare repo): it pushes the
# current branch, and refuses everything else. Hermetic: no network. Requires git.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../scripts/push-branch.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
pass=0 fail=0

ok() { echo "PASS [$1]"; pass=$((pass + 1)); }
no() { echo "FAIL [$1]: $2"; fail=$((fail + 1)); }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q --bare "$WORK/origin.git"
git init -q -b main "$WORK/repo"
R="$WORK/repo"
git -C "$R" remote add origin "$WORK/origin.git"
git -C "$R" commit -q --allow-empty -m init
git -C "$R" push -q origin main
remote_sha() { git -C "$WORK/origin.git" rev-parse --verify --quiet "refs/heads/$1"; }

# 1. A work branch: pushed, upstream set.
git -C "$R" switch -q -c fix/thing
git -C "$R" commit -q --allow-empty -m one
if bash "$SCRIPT" -C "$R" >/dev/null 2>&1 && [ "$(remote_sha fix/thing)" = "$(git -C "$R" rev-parse HEAD)" ]; then ok pushes_current_branch; else no pushes_current_branch "not on origin"; fi
[ "$(git -C "$R" rev-parse --abbrev-ref '@{u}' 2>/dev/null)" = "origin/fix/thing" ] && ok sets_upstream || no sets_upstream "no upstream"

# 1b. On success, one line says what was pushed: branch, remote branch, short SHA.
git -C "$R" commit -q --allow-empty -m one-b
out="$(bash "$SCRIPT" -C "$R" 2>/dev/null)"; code=$?
want="push-branch: pushed fix/thing -> origin/fix/thing at $(git -C "$R" rev-parse --short HEAD)"
[ "$code" -eq 0 ] && [ "$(printf '%s\n' "$out" | grep -c '^push-branch: pushed ')" -eq 1 ] && [[ "$out" == *"$want" ]] && ok says_what_pushed || no says_what_pushed "code=$code out=$out"

# 2. A later commit: pushed as a fast-forward.
git -C "$R" commit -q --allow-empty -m two
bash "$SCRIPT" -C "$R" >/dev/null 2>&1 && [ "$(remote_sha fix/thing)" = "$(git -C "$R" rev-parse HEAD)" ] && ok fast_forward || no fast_forward "second push failed"

# 3. Diverged from origin (history rewritten): refused, origin untouched.
before="$(remote_sha fix/thing)"
git -C "$R" reset -q --hard HEAD~1 && git -C "$R" commit -q --allow-empty -m rewritten
out="$(bash "$SCRIPT" -C "$R" 2>&1)" && no no_force "a diverged push went through" || { [ "$(remote_sha fix/thing)" = "$before" ] && [[ "$out" == *"push-branch: push of 'fix/thing' failed"* ]] && [[ "$out" != *"push-branch: pushed "* ]] && ok no_force || no no_force "origin changed or no failure message: $out"; }

# 3b. A failed push (origin gone): non-zero, a reason, and no "pushed" line. Reset onto
# origin first so the push would otherwise be a plain fast-forward.
git -C "$R" reset -q --hard "$(remote_sha fix/thing)" && git -C "$R" commit -q --allow-empty -m three
mv "$WORK/origin.git" "$WORK/origin.gone"
out="$(bash "$SCRIPT" -C "$R" 2>&1)"; code=$?
mv "$WORK/origin.gone" "$WORK/origin.git"
[ "$code" -ne 0 ] && [[ "$out" == *"push-branch: push of 'fix/thing' failed"* ]] && [[ "$out" != *"push-branch: pushed "* ]] && ok failed_push_reports || no failed_push_reports "code=$code out=$out"

# 4. main and dev: refused, nothing sent.
for b in main dev; do
  git -C "$R" switch -q "$b" 2>/dev/null || git -C "$R" switch -q -c "$b"
  git -C "$R" commit -q --allow-empty -m "on $b"
  before="$(remote_sha "$b")"
  out="$(bash "$SCRIPT" -C "$R" 2>&1)"; code=$?
  if [ "$code" -ne 0 ] && [[ "$out" == *"protected"* ]] && [ "$(remote_sha "$b")" = "$before" ]; then ok "refuses_$b"; else no "refuses_$b" "code=$code out=$out"; fi
done

# 5. Any other argument (a refspec, --force, --delete, --mirror): refused, nothing sent.
git -C "$R" switch -q fix/thing
for args in "--force" "origin +main" "--delete fix/thing" "--mirror" "origin :fix/thing"; do
  # shellcheck disable=SC2086
  out="$(bash "$SCRIPT" -C "$R" $args 2>&1)"; code=$?
  [ "$code" -ne 0 ] && [[ "$out" == *"takes no arguments"* ]] && ok "refuses '$args'" || no "refuses '$args'" "code=$code"
done
[ -n "$(remote_sha fix/thing)" ] && ok branch_not_deleted || no branch_not_deleted "fix/thing gone"

# 6. Detached HEAD: refused.
git -C "$R" switch -q --detach HEAD
out="$(bash "$SCRIPT" -C "$R" 2>&1)"; code=$?
[ "$code" -ne 0 ] && [[ "$out" == *"not on a branch"* ]] && ok refuses_detached || no refuses_detached "code=$code"

echo "push-branch tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
