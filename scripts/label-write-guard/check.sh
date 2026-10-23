#!/usr/bin/env bash
# Fails if a file under plugins/ tells a session to add, remove or swap a lane label.
# Usage: check.sh [root-dir] [allowlist-file]   (defaults: plugins, allowlist.txt beside this script)
#
# A line is flagged when it holds a label-write tool/flag (`--add-label`, `gh ... --label`,
# `labels: [`), `issue_write` with `labels`, or a lane label name on the same line as
# add/remove/swap. A flagged line passes only if allowlist.txt names it:
# `<path> | <the whole line, trimmed>`, one per line, `#` comments.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${1:-plugins}"
allow="${2:-$here/allowlist.txt}"

# The lane labels in graph/constants/labels.ts (keep in step by hand).
lanes='ai-stuck|merge-blocked|ai-ready|ai-reviewing|ai-blocked|ai-discussing|pr-open|auto-reworking|auto-merging|auto-releasing|ready-for-review|ready-for-release'
verbs='\b(add|adds|added|adding|remove|removes|removed|removing|swap|swaps|swapped|swapping)\b'

[ -d "$root" ] || { echo "no such dir: $root" >&2; exit 2; }
root="${root#./}"

hits="$(
  grep -rnIEi \
    -e '--add-label|--remove-label|add_label|remove_label' \
    -e 'issue_write.*labels|labels.*issue_write' \
    -e "gh (issue|pr) (create|edit).*(--label|-l)[ =]+[\"'\`]?(${lanes})" \
    -e "labels[\"']?[:=] *\\[ *[\"'\`]?(${lanes})" \
    -e "${verbs}.*(${lanes})" \
    -e "(${lanes}).*${verbs}" \
    "$root"
)" || { s=$?; [ "$s" -eq 1 ] || { echo "grep failed ($s)" >&2; exit 2; }; }

rc=0
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  file="${hit%%:*}"; rest="${hit#*:}"; text="${rest#*:}"
  trimmed="${text#"${text%%[![:space:]]*}"}"; trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  allowed=0
  if [ -f "$allow" ]; then
    while IFS= read -r entry; do
      case "$entry" in ''|'#'*) continue ;; esac
      apath="${entry%% | *}"; asub="${entry#* | }"
      [ -n "$asub" ] || continue
      if [ "$apath" = "$file" ] && [ "$trimmed" = "$asub" ]; then allowed=1; break; fi
    done < "$allow"
  fi
  if [ "$allowed" -eq 0 ]; then
    echo "label write: ${file}:${rest%%:*}: ${trimmed}"
    rc=1
  fi
done <<< "$hits"

if [ "$rc" -ne 0 ]; then
  echo "Plugins must not tell a session to write a lane label; the Worker applies them." >&2
  echo "If a line only mentions labels, add it to scripts/label-write-guard/allowlist.txt." >&2
fi
exit "$rc"
