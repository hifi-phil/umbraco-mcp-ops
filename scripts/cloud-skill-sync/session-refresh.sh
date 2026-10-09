#!/bin/bash
# session-refresh — the SessionStart hook cloud-skill-sync registers in a cloud environment.
#
# The environment snapshot is cached (~7 days), so without this a session runs whatever
# skills were copied at the last build. This pulls the latest from the repo at each
# session start and re-runs cloud-skill-sync from that checkout: skills, agents, hooks and
# permissions are current without a `rebuild:` bump. Only a change to the setup itself
# (env-setup.sh: SDKs, Docker, images) still needs one.
#
# On any failure (no network, clone timeout) it changes nothing: the session keeps the
# skills from the build. Output goes to $HOME/skill-refresh.log, never stdout (a
# SessionStart hook's stdout is added to the session's context). Always exits 0.
REPO="https://github.com/hifi-phil/umbraco-mcp-ops"
REF="${OPS_REFRESH_REF:-main}"
LOG="$HOME/skill-refresh.log"
# A bound on each step, so a hung network can't hold the session's start.
t() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }

{
  echo "===== session-refresh $(date -u +%Y-%m-%dT%H:%M:%SZ) ($REF) ====="
  # Skip the clone and copy when the last sync (the build's, or a previous
  # session's) delivered the commit $REF is at now.
  head="$(t 20 git ls-remote "$REPO" "refs/heads/$REF" 2>/dev/null | cut -f1)"
  last="$(cat "$HOME/.claude/ops-refresh/synced-commit" 2>/dev/null)"
  if [ -n "$head" ] && [ "$head" = "$last" ]; then
    echo "up to date at ${head:0:7}"
    exit 0
  fi
  src="$(mktemp -d)"
  if t 60 git clone -q --depth 1 --branch "$REF" "$REPO" "$src" \
     && [ -f "$src/scripts/cloud-skill-sync/cloud-skill-sync.sh" ]; then
    echo "pulled $REF at $(git -C "$src" rev-parse --short HEAD)"
    OPS_SRC="$src" SKILL_SYNC_LOG="$HOME/skill-refresh-sync.log" \
      t 90 bash "$src/scripts/cloud-skill-sync/cloud-skill-sync.sh" >/dev/null 2>&1 \
      && echo "refreshed (details: skill-refresh-sync.log)" \
      || echo "WARN: cloud-skill-sync failed or timed out; some skills may be from the build"
  else
    echo "WARN: could not pull $REF; keeping the skills from the build"
  fi
  rm -rf "$src"
} >>"$LOG" 2>&1
exit 0
