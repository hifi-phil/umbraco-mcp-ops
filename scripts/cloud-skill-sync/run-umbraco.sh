#!/usr/bin/env bash
# run-umbraco.sh — bring up a local Umbraco for testing, with a choice of DB provider.
# Run from a checkout of an Umbraco MCP repo (needs its scripts/ + package.json).
#
#   --provider sqlite      (default) server-less SQLite; file-based, fast, bakeable.
#   --provider sqlserver   CI-parity: SQL Server 2022 via Docker (exact image + creds
#                          from .github/workflows/test.yml). Not bakeable (DB in container).
#   --seed <major>         sqlite only: restore a pre-baked seed from ~/umbraco-seed/<major>
#                          (built by env-setup.sh) instead of a fresh bootstrap — near-instant.
#   --no-test-user         skip create-api-user / publish-root-content (just boot).
#
# Assumes env-setup.sh already installed the .NET SDK (dotnet on PATH via /usr/local/bin).
# Prints the base URL on success; leaves Umbraco running in the background.
set -uo pipefail

PROVIDER="sqlite"; SEED=""; TEST_USER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --provider) PROVIDER="${2:-}"; shift 2 ;;
    --seed)     SEED="${2:-}"; shift 2 ;;
    --no-test-user) TEST_USER=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$HOME/.dotnet:$HOME/.dotnet/tools:$PATH"
export NODE_TLS_REJECT_UNAUTHORIZED=0   # demo-site uses a self-signed HTTPS dev cert

# CI-parity SQL Server (matches .github/workflows/test.yml)
MSSQL_IMAGE="mcr.microsoft.com/mssql/server:2022-latest"
SA_PASSWORD="Moloko99"
MSSQL_DB="umbraco-mcp-local"

[ -d demo-site-template ] || { echo "ERROR: run from an MCP repo checkout (no demo-site-template/)"; exit 1; }
command -v dotnet >/dev/null 2>&1 || { echo "ERROR: dotnet not on PATH — env-setup.sh installs it"; exit 1; }
[ -d node_modules ] || { echo "node_modules missing — running npm ci…"; npm ci; }

# The routine env ships no Docker — install the engine and start the daemon on demand
# (only for --provider sqlserver). Needs root + a daemon that can actually run here; if
# `dockerd` can't start (unprivileged sandbox), this reports it so we can fall back to a
# native `mssql-server` apt install instead.
ensure_docker() {
  if docker info >/dev/null 2>&1; then echo "docker ready"; return 0; fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "installing docker engine…"
    if command -v apt-get >/dev/null 2>&1; then
      (apt-get update -qq && apt-get install -y docker.io) || echo "WARN: apt-get docker.io failed"
    else
      echo "ERROR: no apt-get to install docker"; return 1
    fi
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "starting docker daemon…"
    service docker start >/dev/null 2>&1 || (nohup dockerd >/tmp/dockerd.log 2>&1 &)
    for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 2; done
  fi
  docker info >/dev/null 2>&1 || {
    echo "ERROR: docker installed but the daemon won't run in this env (likely no privileged/dind support)."
    echo "       See /tmp/dockerd.log. Fall back to a native SQL Server install (apt mssql-server) — tell me and I'll add that path."
    return 1
  }
}

case "$PROVIDER" in
  sqlite)
    if [ -n "$SEED" ] && [ -d "$HOME/umbraco-seed/$SEED" ]; then
      echo "restoring pre-baked SQLite seed ~/umbraco-seed/$SEED …"
      rm -rf demo-site && mkdir -p demo-site && rsync -a "$HOME/umbraco-seed/$SEED/" demo-site/
    else
      echo "bootstrapping fresh SQLite demo-site…"
      npm run umbraco:bootstrap -- --sqlite --force
    fi ;;
  sqlserver)
    ensure_docker || { echo "ERROR: docker unavailable — cannot run the SQL Server container"; exit 1; }
    if ! docker ps --format '{{.Names}}' | grep -qx mssql; then
      echo "starting SQL Server 2022 (docker)…"
      docker rm -f mssql >/dev/null 2>&1 || true
      docker run -d --name mssql -e ACCEPT_EULA=Y -e "MSSQL_SA_PASSWORD=$SA_PASSWORD" -p 1433:1433 "$MSSQL_IMAGE" >/dev/null \
        || { echo "ERROR: could not start SQL Server container"; exit 1; }
    fi
    echo "waiting for SQL Server to accept connections…"
    ready=0
    for _ in $(seq 1 40); do
      if docker exec mssql /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$SA_PASSWORD" -C -Q "SELECT 1" >/dev/null 2>&1; then ready=1; break; fi
      sleep 3
    done
    [ "$ready" -eq 1 ] || { echo "ERROR: SQL Server did not become ready"; docker logs --tail 40 mssql; exit 1; }
    echo "SQL Server ready; bootstrapping demo-site + SQL Server connection string…"
    npm run umbraco:bootstrap -- --force
    cat > demo-site/appsettings.local.json <<JSONEOF
{
  "ConnectionStrings": {
    "umbracoDbDSN": "Server=localhost,1433;Database=$MSSQL_DB;User Id=sa;Password=$SA_PASSWORD;TrustServerCertificate=True",
    "umbracoDbDSN_ProviderName": "Microsoft.Data.SqlClient"
  }
}
JSONEOF
    ;;
  *) echo "ERROR: unknown --provider '$PROVIDER' (use sqlite or sqlserver)"; exit 1 ;;
esac

dotnet dev-certs https >/dev/null 2>&1 || true

echo "starting Umbraco ($PROVIDER)…"
npm run start:umbraco > /tmp/umbraco-run.log 2>&1 &
base=""
for i in $(seq 1 90); do
  if [ -f .demo-site-port ]; then
    port="$(cat .demo-site-port)"
    if curl -ksf "https://localhost:$port/umbraco/management/api/v1/server/status" >/dev/null 2>&1; then base="https://localhost:$port"; break; fi
  fi
  if [ $((i % 6)) -eq 0 ]; then echo "still booting (~$((i * 5))s)…"; tail -n 1 /tmp/umbraco-run.log 2>/dev/null; fi
  sleep 5
done
[ -n "$base" ] || { echo "ERROR: Umbraco did not become ready; boot log:"; tail -n 40 /tmp/umbraco-run.log; exit 1; }

if [ "$TEST_USER" -eq 1 ]; then
  node scripts/create-api-user.mjs "$base"       || echo "WARN: create-api-user failed"
  node scripts/publish-root-content.mjs "$base"  || echo "WARN: publish-root-content failed"
fi

echo ""
echo "==> Umbraco ($PROVIDER) ready at $base"
echo "==> Run the change's tests with:  npm run test:changed   (or: npm run test:one -- --testPathPattern='…')"
