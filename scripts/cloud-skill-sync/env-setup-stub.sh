#!/usr/bin/env bash
# ── PASTE THIS (and ONLY this) into the cloud environment's Setup script field ──
#
# It clones umbraco-mcp-ops and runs the real setup, which delivers the loop
# skills/agents/hooks and installs the credential-free heavy bits (.NET SDK, and — for a
# SQL Server env — Docker + the mssql image). The demo-site itself is bootstrapped per
# SESSION by run-umbraco.sh (env-build has no git creds for the private repo). All logic
# lives in the repo (boot.sh -> env-setup.sh -> cloud-skill-sync.sh), edited via PRs —
# you only re-paste THIS, and it's two lines.
#
# TWO ENVIRONMENTS — the last word on the curl line:
#   sqlite     lean env: SDK + skills. Sessions run Umbraco on server-less SQLite.
#   sqlserver  CI-parity env: also installs Docker + caches the mssql:2022 image (~2.3 GB)
#              so sessions can run Umbraco on SQL Server exactly as GH Actions does.
#
# FORCE A REBUILD: bump the `rebuild:` number and re-save. The env snapshot is cached and
# only busts when THIS field's text changes — a stub that always pulls `main` won't rebuild
# itself when the repo script changes. Bump the number to re-pull.
#
# NOTE: owner is `hifi-phil` until the repo moves to the `umbraco` org (ops #40); after the
#       move, change the URL here and in boot.sh to umbraco/umbraco-mcp-ops.
# rebuild: 1
curl -fsSL https://raw.githubusercontent.com/hifi-phil/umbraco-mcp-ops/main/scripts/cloud-skill-sync/boot.sh -o /tmp/boot.sh && bash /tmp/boot.sh sqlite   # or: sqlserver
