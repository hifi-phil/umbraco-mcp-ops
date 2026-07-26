#!/usr/bin/env bash
# SessionStart hook — boot an Umbraco instance in the BACKGROUND at session start so it's
# ready by the time any loop needs it. Delivered + registered by cloud-skill-sync.
#
# Fast + non-blocking: it launches run-umbraco.sh detached and exits immediately (never
# blocks session start). No-op unless the session's checkout is an Umbraco MCP repo, so it's
# harmless on the ops repo, docs repos, etc. Provider (sqlite|sqlserver) is whatever the env
# was built for (written to /root/.umbraco-ops/provider by env-setup).
set -uo pipefail

PROJECT="${CLAUDE_PROJECT_DIR:-$PWD}"
RUN="/root/.umbraco-ops/run-umbraco.sh"
LOG="/tmp/umbraco-boot.log"

[ -d "$PROJECT/demo-site-template" ] || exit 0     # not an Umbraco MCP repo → skip quietly
[ -f "$RUN" ]                        || exit 0     # env-setup hasn't delivered it → skip
[ -f "$PROJECT/.demo-site-port" ]    && exit 0     # already up / booting → don't double-boot

provider="$(cat /root/.umbraco-ops/provider 2>/dev/null || echo sqlite)"
cd "$PROJECT" || exit 0
echo "[session-start] booting Umbraco ($provider) in the background → $LOG" >>"$LOG"
nohup bash "$RUN" --provider "$provider" >>"$LOG" 2>&1 &
exit 0
