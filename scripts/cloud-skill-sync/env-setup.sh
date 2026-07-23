#!/usr/bin/env bash
# env-setup.sh — cloud env build for the Umbraco MCP loop workers.
#
# Invoked by the tiny stub in the env Setup script field (env-setup-stub.sh). Runs
# ONCE at env-build (before any session), and everything it writes under $HOME is
# captured in the env snapshot; a session's repo checkout is fresh each time, so
# anything a session needs must live under $HOME.
#
# It does three things:
#   1. Deliver skills/agents/hooks         (delegates to cloud-skill-sync.sh)  — REQUIRED
#   2. Install the .NET SDK                ($HOME/.dotnet)                      — best-effort
#   3. Bake a ready-to-run Umbraco (SQLite) seed per version                   — best-effort
#      ($HOME/umbraco-seed/<major>/ = a booted, API-user'd, root-published demo-site)
#
# Steps 2–3 are best-effort: if a seed can't build, the build/rework loops simply skip
# their local test pre-flight (and lean on CI) — the loops themselves still run. Only the
# skill delivery is required.
#
# Design + rationale: docs/specs/cloud-umbraco-validation.md.
# See also reference: the .NET install pattern below (raw-github dotnet-install.sh; the
# dot.net/v1 URL 301-redirects and traps curl without -L).
set -uo pipefail

VERSION="1"                       # log marker only — the cache-bust is `rebuild:` in the stub
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HOME/env-setup.log"
SEED_ROOT="$HOME/umbraco-seed"

export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
export NODE_TLS_REJECT_UNAUTHORIZED=0   # demo-site uses a self-signed HTTPS dev cert

# Versions to pre-seed: "major:repo_url:branch:dotnet_channel".
# Branches verified to exist (dev, v17/dev). Channel .NET 10 for both matches CI
# (.github/workflows/test.yml uses dotnet 10.0.x on the current tree). If a future major
# targets a different .NET (check docs.umbraco.com/umbraco-cms/<version>.latest — the
# supported .NET tracks the CMS release), add its channel here. A wrong branch/channel just
# makes that one seed skip (best-effort), it won't break env-build.
SEED_TARGETS=(
  "18:https://github.com/umbraco/Umbraco-CMS-MCP-Editor:dev:10.0"
  "17:https://github.com/umbraco/Umbraco-CMS-MCP-Editor:v17/dev:10.0"
)

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

# ── System tools the seed build needs ──────────────────────────────────────
# rsync is used by the repo's bootstrap-demo-site.sh AND by our snapshot step, but the
# cloud worker image doesn't ship it. Install it (runs as root; apt available on the
# Ubuntu image). Best-effort — a failure just means the seeds can't build.
ensure_tools() {
  command -v rsync >/dev/null 2>&1 && { log "rsync present"; return 0; }
  log "installing rsync (needed by bootstrap-demo-site.sh + snapshot)"
  if command -v apt-get >/dev/null 2>&1; then
    (apt-get update -qq && apt-get install -y rsync) >>"$LOG" 2>&1 || log "WARN: apt-get rsync failed"
  fi
  command -v rsync >/dev/null 2>&1 || log "WARN: rsync still missing — seeds will fail"
}

# ── 2. .NET SDK (idempotent) ───────────────────────────────────────────────
install_dotnet() {
  local channel="$1"
  if dotnet --list-sdks 2>/dev/null | grep -q "^${channel%.*}\."; then
    log ".NET SDK for channel $channel already present"; return 0
  fi
  log "installing .NET SDK channel $channel"
  local tmp; tmp="$(mktemp -d)/dotnet-install.sh"
  # Fetch the script directly from GitHub — dot.net/v1/dotnet-install.sh 301-redirects and
  # curl without -L silently writes an empty file and exits 0.
  if ! curl -fsSL -o "$tmp" https://raw.githubusercontent.com/dotnet/install-scripts/main/src/dotnet-install.sh; then
    log "WARN: could not download dotnet-install.sh (channel $channel)"; return 1
  fi
  chmod +x "$tmp"
  "$tmp" --channel "$channel" --install-dir "$HOME/.dotnet" || { log "WARN: dotnet install failed ($channel)"; return 1; }
  # Persist for session shells.
  if ! grep -q 'DOTNET_ROOT=$HOME/.dotnet' "$HOME/.bashrc" 2>/dev/null; then
    { echo 'export DOTNET_ROOT=$HOME/.dotnet'
      echo 'export PATH=$HOME/.dotnet:$HOME/.dotnet/tools:$PATH'; } >> "$HOME/.bashrc"
  fi
  dotnet --version >/dev/null 2>&1 || { log "WARN: dotnet not usable after install"; return 1; }
}

# ── 3. Per-version Umbraco (SQLite) seed (idempotent, best-effort) ─────────
# Clone the target repo at <branch>, bootstrap a SQLite demo-site, boot it once (which
# runs the unattended install AND creates the API user via start:umbraco), publish root
# content, stop, and snapshot the prepared demo-site to $SEED_ROOT/<major>/. A session
# then copies that in and boots in seconds. Warms ~/.nuget/packages as a side effect.
build_seed() {
  local major="$1" repo="$2" branch="$3" channel="$4"
  local dest="$SEED_ROOT/$major"
  if [ -d "$dest" ] && [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
    log "seed for Umbraco $major already present ($dest) — skipping"; return 0
  fi
  install_dotnet "$channel" || { log "WARN: no SDK for $major — skipping seed"; return 1; }
  dotnet dev-certs https >/dev/null 2>&1 || true

  local work; work="$(mktemp -d)"
  log "seed $major: cloning $repo@$branch"
  if ! git clone --depth 1 --branch "$branch" "$repo" "$work/app" 2>>"$LOG"; then
    log "WARN: clone failed for $major ($repo@$branch) — skipping seed"; rm -rf "$work"; return 1
  fi
  ( set -e
    cd "$work/app"
    npm ci
    npm run umbraco:bootstrap -- --sqlite            # server-less SQLite demo-site
    # Boot once (backgrounded): start:umbraco runs dotnet run, writes .demo-site-port +
    # UMBRACO_BASE_URL, and creates the API user itself.
    npm run start:umbraco > "$work/start.log" 2>&1 &

    # Wait for the port file + a live server-status response (first boot = unattended install).
    base=""
    for _ in $(seq 1 90); do            # ~7.5 min ceiling for a cold first-boot install
      if [ -f .demo-site-port ]; then
        port="$(cat .demo-site-port)"
        if curl -ksf "https://localhost:$port/umbraco/management/api/v1/server/status" >/dev/null 2>&1; then
          base="https://localhost:$port"; break
        fi
      fi
      sleep 5
    done
    [ -n "$base" ] || { echo "seed $major: Umbraco did not become ready"; tail -n 40 "$work/start.log"; exit 1; }

    node scripts/publish-root-content.mjs "$base" || echo "seed $major: publish-root-content warned"
    npm run stop:umbraco || true

    # Snapshot the prepared demo-site (DB + built output + generated files); drop transient
    # per-run files so a session's start:umbraco rewrites them cleanly.
    mkdir -p "$dest"
    rsync -a --delete \
      --exclude '.demo-site-port' --exclude '.demo-site-pid' \
      "$work/app/demo-site/" "$dest/"
  ) 2>>"$LOG"
  local rc=$?
  rm -rf "$work"
  if [ "$rc" -eq 0 ] && [ -d "$dest" ]; then
    log "seed $major: baked -> $dest"
  else
    log "WARN: seed $major failed (rc=$rc) — build/rework loops will skip its test pre-flight"
    rm -rf "$dest"
  fi
  return "$rc"
}

# ── main ───────────────────────────────────────────────────────────────────
{
  log "===== env-setup v$VERSION ====="
  deliver_skills
  ensure_tools
  mkdir -p "$SEED_ROOT"
  for t in "${SEED_TARGETS[@]}"; do
    # t = "<major>:<repo_url>:<branch>:<channel>"; repo_url contains ':' (https://),
    # so take major from the left and split the rest from the RIGHT.
    major="${t%%:*}"          # 18
    rest="${t#*:}"            # repo_url:branch:channel
    channel="${rest##*:}"     # 10.0
    rest="${rest%:*}"         # repo_url:branch
    branch="${rest##*:}"      # dev
    repo="${rest%:*}"         # https://github.com/…
    log "seed target: major=$major repo=$repo branch=$branch channel=$channel"
    build_seed "$major" "$repo" "$branch" "$channel" || true
  done
  log "dotnet: $(dotnet --version 2>/dev/null || echo 'not installed')"
  log "seeds:  $(ls -1 "$SEED_ROOT" 2>/dev/null | tr '\n' ' ')"
  log "===== env-setup done ====="
} 2>&1 | tee -a "$LOG"
exit 0
