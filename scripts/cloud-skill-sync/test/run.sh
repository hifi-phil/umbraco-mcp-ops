#!/usr/bin/env bash
# Hermetic tests for the cloud-skill-sync scripts — bash + jq only, no network / dotnet /
# docker. Covers the pure-logic bits: the SessionStart boot-hook guards, the SessionStart
# hook-registration idempotency, and `bash -n` on every script.
#
# Usage: bash run.sh   (exits non-zero if any case fails)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$(cd "$HERE/.." && pwd)"                 # scripts/cloud-skill-sync
ROOT="$(cd "$HERE/../../.." && pwd)"          # repo root
HOOK="$ROOT/plugins/mcp-issue-loop/hooks/session-start-umbraco.sh"

command -v jq >/dev/null 2>&1 || { echo "FATAL: jq required"; exit 2; }
[ -f "$HOOK" ] || { echo "FATAL: hook not found: $HOOK"; exit 2; }

pass=0 fail=0
ok()  { pass=$((pass+1)); }                    # echo "ok: $1"
bad() { fail=$((fail+1)); echo "FAIL: $1"; }

# ── session-start-umbraco.sh guards ────────────────────────────────────────
# tpl/port/mkrun/expect are 0/1. The stubbed run-umbraco writes its args to a marker so we
# can tell whether (and how) it was launched.
hook_case() {
  local name="$1" tpl="$2" port="$3" mkrun="$4" expect="$5"
  local work; work="$(mktemp -d)"
  local proj="$work/proj"; mkdir -p "$proj"
  [ "$tpl" = 1 ]  && mkdir -p "$proj/demo-site-template"
  [ "$port" = 1 ] && echo 12345 > "$proj/.demo-site-port"
  local marker="$work/booted" runscript="$work/run-umbraco.sh"
  if [ "$mkrun" = 1 ]; then
    printf '#!/usr/bin/env bash\nprintf "%%s" "$*" > "%s"\n' "$marker" > "$runscript"; chmod +x "$runscript"
  fi
  echo sqlite > "$work/provider"
  CLAUDE_PROJECT_DIR="$proj" UMBRACO_RUN_SCRIPT="$runscript" \
    UMBRACO_PROVIDER_FILE="$work/provider" UMBRACO_BOOT_LOG="$work/boot.log" \
    bash "$HOOK" </dev/null
  for _ in $(seq 1 30); do [ -f "$marker" ] && break; sleep 0.1; done   # await the detached stub
  if [ "$expect" = 1 ]; then
    if [ -f "$marker" ] && grep -q -- '--provider sqlite' "$marker"; then ok "$name"
    else bad "$name — expected boot w/ '--provider sqlite', marker='$(cat "$marker" 2>/dev/null)'"; fi
  else
    if [ -f "$marker" ]; then bad "$name — expected NO boot, but it launched"; else ok "$name"; fi
  fi
  rm -rf "$work"
}
hook_case "boots: MCP repo + run present + not already booting" 1 0 1 1
hook_case "skips: no demo-site-template (not an MCP repo)"       0 0 1 0
hook_case "skips: already booting (.demo-site-port present)"     1 1 1 0
hook_case "skips: run-umbraco.sh not delivered"                  1 0 0 0

# ── SessionStart registration idempotency ──────────────────────────────────
# Mirrors the jq in cloud-skill-sync.sh — registering twice must yield exactly one entry.
reg() {
  jq --arg cmd "$1" '
    .hooks = (.hooks // {})
    | .hooks.SessionStart = (.hooks.SessionStart // [])
    | if any(.hooks.SessionStart[]?; any(.hooks[]?; .command == $cmd)) then .
      else .hooks.SessionStart += [ {"hooks": [ {"type":"command","command":$cmd,"async":true} ]} ] end'
}
CMD='bash /root/.umbraco-ops/session-start-umbraco.sh'
s1="$(echo '{}' | reg "$CMD")"; n1="$(echo "$s1" | jq '.hooks.SessionStart | length')"
s2="$(echo "$s1" | reg "$CMD")"; n2="$(echo "$s2" | jq '.hooks.SessionStart | length')"
async="$(echo "$s2" | jq -r '.hooks.SessionStart[0].hooks[0].async')"
{ [ "$n1" = 1 ] && [ "$n2" = 1 ] && [ "$async" = true ]; } \
  && ok "SessionStart registration: idempotent + async" \
  || bad "SessionStart registration wrong (n1=$n1 n2=$n2 async=$async)"

# ── bash -n on every script + the hook ──────────────────────────────────────
for f in "$DIR"/*.sh "$HOOK"; do
  bash -n "$f" 2>/dev/null && ok "bash -n $(basename "$f")" || bad "bash -n $(basename "$f")"
done

echo "----"
echo "cloud-skill-sync tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
