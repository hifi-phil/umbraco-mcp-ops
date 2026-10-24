#!/usr/bin/env bash
# Self-test: a long description and a broken link fail; a clean tree passes.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
fail=0
mkdir -p "$work/ok/s" "$work/long/s" "$work/link/s"
printf -- '---\nname: s\ndescription: >-\n  short and fine.\n---\nSee [ref](s.md).\n' > "$work/ok/s/SKILL.md"; cp "$work/ok/s/SKILL.md" "$work/ok/s/s.md"
{ printf -- '---\nname: s\ndescription: >-\n'; for _ in $(seq 1 30); do printf '  %s\n' "forty characters of description text here"; done; printf -- '---\n'; } > "$work/long/s/SKILL.md"
printf -- '---\nname: s\ndescription: fine\n---\nSee [gone](missing.md).\n' > "$work/link/s/SKILL.md"
node "$here/check.mjs" "$work/ok" >/dev/null || { echo "FAIL: clean tree flagged"; fail=1; }
out="$(node "$here/check.mjs" "$work/long")"; rc=$?
{ [ "$rc" -eq 1 ] && grep -q "description is" <<<"$out"; } || { echo "FAIL: long description not flagged"; fail=1; }
out="$(node "$here/check.mjs" "$work/link")"; rc=$?
{ [ "$rc" -eq 1 ] && grep -q "doesn't resolve" <<<"$out"; } || { echo "FAIL: broken link not flagged"; fail=1; }
[ "$fail" -eq 0 ] && echo "skill-lint self-test: ok"
exit "$fail"
