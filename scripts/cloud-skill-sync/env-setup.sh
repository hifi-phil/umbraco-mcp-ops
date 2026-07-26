#!/usr/bin/env bash
# env-setup.sh — cloud env WARM-UP for the Umbraco MCP loop workers.
#
# Invoked once at env-build by the stub in the env Setup script field (env-setup-stub.sh).
# It caches only the slow, CREDENTIAL-FREE downloads — the things that reliably persist —
# so a session can bring Umbraco up quickly:
#   1. skills / agents / hooks           (delegates to cloud-skill-sync.sh)   [required]
#   2. rsync                             (bootstrap-demo-site.sh needs it)
#   3. .NET SDK                          ($HOME/.dotnet, symlinked to /usr/local/bin)
#   4. (sqlserver only) Docker + the mssql:2022 image, in Docker's persistent store
#
# It deliberately does NOT pre-bake an Umbraco instance — caching a baked instance proved
# unreliable (needs a build-phase token for the private repo, and the plain seed dir isn't
# retained across rebuilds). Instead, a SESSION runs run-umbraco.sh to bootstrap demo-site/
# and boot Umbraco (~a couple of minutes) against the chosen DB. Everything here is
# credential-free, so there's no private-repo / token dependency at build time.
#
# Two environments from one stub, via --provider (or DB_PROVIDER):
#   sqlite     lean: skills + SDK. Sessions run Umbraco on server-less SQLite.
#   sqlserver  CI-parity: also Docker + the cached mssql image, for SQL Server sessions.
#
# Design: docs/specs/cloud-umbraco-validation.md.
set -uo pipefail

VERSION="2"                       # log marker only — the cache-bust is `rebuild:` in the stub
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HOME/env-setup.log"

export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"

MSSQL_IMAGE="mcr.microsoft.com/mssql/server:2022-latest"
DOCKER_DATA_ROOT="${DOCKER_DATA_ROOT:-/root/.docker-data}"   # persistent (proven)
DOTNET_CHANNEL="${DOTNET_CHANNEL:-10.0}"
MANIFEST="/root/env-manifest.md"
OPS_SCRIPTS_DIR="/root/.umbraco-ops"

PROVIDER="${DB_PROVIDER:-sqlite}"
_prev=""; for _a in "$@"; do [ "$_prev" = "--provider" ] && PROVIDER="$_a"; _prev="$_a"; done

log() { printf '%s %s\n' "$(date -u +%FT%TZ 2>/dev/null || echo now)" "$*" | tee -a "$LOG"; }

# ── 1. Skills / agents / hooks (required) ──────────────────────────────────
deliver_skills() {
  if [ -f "$HERE/cloud-skill-sync.sh" ]; then
    log "delivering skills/agents/hooks via cloud-skill-sync.sh"
    bash "$HERE/cloud-skill-sync.sh" || log "WARN: cloud-skill-sync.sh returned non-zero"
  else
    log "ERROR: cloud-skill-sync.sh not found next to env-setup.sh"
  fi
}

# ── 2. rsync (bootstrap-demo-site.sh uses it; the base image may not ship it) ──
ensure_tools() {
  command -v rsync >/dev/null 2>&1 && { log "rsync present"; return 0; }
  log "installing rsync"
  command -v apt-get >/dev/null 2>&1 && (apt-get update -qq && apt-get install -y rsync) >>"$LOG" 2>&1 || log "WARN: apt-get rsync failed"
  command -v rsync >/dev/null 2>&1 || log "WARN: rsync still missing — run-umbraco bootstrap will fail"
}

# ── 3. .NET SDK ────────────────────────────────────────────────────────────
# Symlink onto a PATH dir every shell sees — .bashrc isn't sourced by start:umbraco's
# `nohup dotnet run`, so without this the backgrounded boot fails "command not found".
link_dotnet() { [ -x "$HOME/.dotnet/dotnet" ] && ln -sf "$HOME/.dotnet/dotnet" /usr/local/bin/dotnet 2>/dev/null || true; }

install_dotnet() {
  local channel="$1"
  if dotnet --list-sdks 2>/dev/null | grep -q "^${channel%.*}\."; then
    log ".NET SDK channel $channel already present"; link_dotnet; return 0
  fi
  log "installing .NET SDK channel $channel"
  local tmp; tmp="$(mktemp -d)/dotnet-install.sh"
  # raw-github URL, NOT dot.net/v1 (which 301-redirects and traps curl into an empty file).
  if ! curl -fsSL -o "$tmp" https://raw.githubusercontent.com/dotnet/install-scripts/main/src/dotnet-install.sh; then
    log "WARN: could not download dotnet-install.sh"; return 1
  fi
  chmod +x "$tmp"
  "$tmp" --channel "$channel" --install-dir "$HOME/.dotnet" || { log "WARN: dotnet install failed"; return 1; }
  if ! grep -q 'DOTNET_ROOT=$HOME/.dotnet' "$HOME/.bashrc" 2>/dev/null; then
    { echo 'export DOTNET_ROOT=$HOME/.dotnet'; echo 'export PATH=$HOME/.dotnet:$HOME/.dotnet/tools:$PATH'; } >> "$HOME/.bashrc"
  fi
  dotnet --version >/dev/null 2>&1 || { log "WARN: dotnet not usable after install"; return 1; }
  link_dotnet
}

# ── 4. Docker + mssql image (sqlserver only) ───────────────────────────────
# Use an existing daemon if one is running; else install + start dockerd with a data-root
# under the persistent store, so the pulled image survives to sessions.
ensure_docker() {
  if docker info >/dev/null 2>&1; then log "docker ready (existing daemon)"; return 0; fi
  if ! command -v docker >/dev/null 2>&1; then
    log "installing docker engine"
    command -v apt-get >/dev/null 2>&1 && (apt-get update -qq && apt-get install -y docker.io) >>"$LOG" 2>&1 || log "WARN: apt-get docker.io failed"
  fi
  mkdir -p "$DOCKER_DATA_ROOT"
  log "starting docker daemon (data-root $DOCKER_DATA_ROOT)"
  service docker stop >/dev/null 2>&1 || true
  (nohup dockerd --data-root "$DOCKER_DATA_ROOT" >/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 2; done
  docker info >/dev/null 2>&1 || { log "WARN: dockerd won't run here (see /tmp/dockerd.log)"; return 1; }
}

prep_sqlserver() {
  log "prep SQL Server: docker + cache the mssql image"
  ensure_docker || { log "WARN: docker unavailable — mssql image not cached"; return 1; }
  if docker image inspect "$MSSQL_IMAGE" >/dev/null 2>&1; then
    log "mssql image already cached ($(docker images --format '{{.Size}}' "$MSSQL_IMAGE" | head -1)) — skip pull"; return 0
  fi
  log "pulling $MSSQL_IMAGE (~2.3 GB; cached in $DOCKER_DATA_ROOT)"
  docker pull "$MSSQL_IMAGE" >>"$LOG" 2>&1 && log "mssql image cached" || log "WARN: docker pull failed"
}

# ── Manifest — tell the session what's here + how to bring Umbraco up ──────
write_manifest() {
  mkdir -p "$OPS_SCRIPTS_DIR"
  cp "$HERE/run-umbraco.sh" "$OPS_SCRIPTS_DIR/" 2>/dev/null || true
  local docker_line="not installed (sqlite env)" has_mssql=0
  if [ "$PROVIDER" = "sqlserver" ]; then
    if docker image inspect "$MSSQL_IMAGE" >/dev/null 2>&1; then
      docker_line="mssql image cached ($(docker images --format '{{.Size}}' "$MSSQL_IMAGE" | head -1))"; has_mssql=1
    else
      docker_line="requested but image NOT cached (see this log)"
    fi
  fi
  local db_section
  if [ "$has_mssql" = "1" ]; then
    db_section="$(cat <<'DBEOF'
**SQL Server is available** (image cached) — the daemon isn't running yet (it doesn't persist
across sessions); "not running" means startable, not unavailable. Check live:
```
docker info >/dev/null 2>&1 && echo RUNNING || echo "AVAILABLE (not started)"
```
- **RUNNING** → `--provider sqlserver`.
- **AVAILABLE (not started)** → `run-umbraco.sh --provider sqlserver` starts it (daemon +
  container from the cached image), or use `--provider sqlite` for a quick test.
DBEOF
)"
  else
    db_section="Only **SQLite** is available (no mssql image). Use \`--provider sqlite\`."
  fi
  cat > "$MANIFEST" <<EOF
# Umbraco MCP worker environment — ready ($(date -u +%FT%TZ 2>/dev/null || echo 'time n/a'))

**Agent: read this first.** Written on every env build (initial or cached rebuild) so you
don't need to probe. There is **no pre-baked Umbraco instance** — you bring one up per
session with run-umbraco.sh (bootstrap + boot, ~1–2 min).

| What        | State |
|-------------|-------|
| Provider    | $PROVIDER |
| .NET SDK    | $(dotnet --version 2>/dev/null || echo 'NOT installed') (on PATH via /usr/local/bin) |
| SQL Server image | $docker_line |
| Skills      | delivered to ~/.claude/skills |
| Ops scripts | $OPS_SCRIPTS_DIR (run-umbraco.sh) |

## Which database to use RIGHT NOW
$db_section

## Bring up Umbraco (run from your repo checkout)
\`\`\`
bash $OPS_SCRIPTS_DIR/run-umbraco.sh --provider <sqlite|sqlserver>
\`\`\`
It bootstraps demo-site/, boots Umbraco as a background process (SQLite, or Docker+SQL
Server), creates the API user, and writes .env. First boot runs the unattended install
(~1–2 min). Then \`npm run test:changed\` (or \`npm test\`) runs against it.
EOF
  log "wrote manifest: $MANIFEST"
}

# ── main ───────────────────────────────────────────────────────────────────
{
  log "===== env-setup v$VERSION (provider=$PROVIDER) ====="
  deliver_skills
  ensure_tools
  install_dotnet "$DOTNET_CHANNEL"
  [ "$PROVIDER" = "sqlserver" ] && { prep_sqlserver || true; }
  write_manifest
  log "dotnet: $(dotnet --version 2>/dev/null || echo 'not installed')"
  [ "$PROVIDER" = "sqlserver" ] && log "mssql image: $(docker images --format '{{.Size}}' "$MSSQL_IMAGE" 2>/dev/null | head -1 || echo 'not cached')"
  log "===== env-setup done (manifest: $MANIFEST) ====="
} 2>&1 | tee -a "$LOG"
exit 0
