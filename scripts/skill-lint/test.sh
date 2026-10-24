#!/usr/bin/env bash
# Self-test: a long description (block, plain multi-line, CRLF, trailing-space header), a missing
# description and a broken link fail; a clean tree passes.
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
long="$(printf 'forty characters of description text here %.0s' $(seq 1 30))"
expect_fail() { # name, pattern
  out="$(node "$here/check.mjs" "$work/$1")"; rc=$?
  { [ "$rc" -eq 1 ] && grep -q "$2" <<<"$out"; } || { echo "FAIL: $1 not flagged"; fail=1; }
}
mkdir -p "$work/plain/s" "$work/crlf/s" "$work/space/s" "$work/nofm/s"
printf -- '---\nname: s\ndescription: short\n  %s\n---\n' "$long" > "$work/plain/s/SKILL.md"
printf -- '---\r\nname: s\r\ndescription: %s\r\n---\r\n' "$long" > "$work/crlf/s/SKILL.md"
printf -- '---\nname: s\ndescription: >- \n  %s\n---\n' "$long" > "$work/space/s/SKILL.md"
printf 'no frontmatter here\n' > "$work/nofm/s/SKILL.md"
expect_fail plain "description is"
expect_fail crlf "description is"
expect_fail space "description is"
expect_fail nofm "no frontmatter description"
[ "$fail" -eq 0 ] && echo "skill-lint self-test: ok"
exit "$fail"
