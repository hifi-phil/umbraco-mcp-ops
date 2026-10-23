#!/usr/bin/env bash
# Tests for check.sh. Run from anywhere.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo"
fail=0
rel="scripts/label-write-guard"

out="$("$rel/check.sh" "$rel/fixtures/bad" "$rel/fixtures/allowlist.txt" 2>&1)" && { echo "FAIL: bad fixture passed"; fail=1; }
for n in 1 2 3 4 5 6 7 8 9 10; do
  grep -q "SKILL.md:$n:" <<<"$out" || { echo "FAIL: bad fixture line $n not reported"; fail=1; }
done

out="$("$rel/check.sh" "$rel/fixtures/allowed" "$rel/fixtures/allowlist.txt" 2>&1)" \
  && { echo "FAIL: allowed fixture passed with an extra write on an allowlisted path"; fail=1; }
grep -q "SKILL.md:2:" <<<"$out" || { echo "FAIL: extra write on allowlisted path not reported"; fail=1; }
grep -q "SKILL.md:1:" <<<"$out" && { echo "FAIL: allowlisted line reported"; fail=1; }

"$rel/check.sh" "$rel/fixtures/allowed" /dev/null >/dev/null 2>&1 \
  && { echo "FAIL: allowed fixture passed without its allowlist entry"; fail=1; }

"$rel/check.sh" does-not-exist >/dev/null 2>&1 && { echo "FAIL: missing root passed"; fail=1; }

"$rel/check.sh" plugins || { echo "FAIL: plugins/ has label writes"; fail=1; }

[ "$fail" -eq 0 ] && echo "label-write-guard: all passed"
exit "$fail"
