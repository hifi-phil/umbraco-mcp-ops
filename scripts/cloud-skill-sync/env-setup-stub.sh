#!/usr/bin/env bash
# ── PASTE THIS (and ONLY this) into the cloud environment's Setup script field ──
#
# It clones umbraco-mcp-ops and runs the real setup, which delivers the loop
# skills/agents/hooks and installs the credential-free heavy bits (.NET SDK, and — for a
# SQL Server env — Docker + the mssql image). The demo-site itself is bootstrapped per
# SESSION by run-umbraco.sh (env-build has no git creds for the private repo). All logic
# lives in the repo (env-setup.sh -> cloud-skill-sync.sh), edited via PRs — you only
# re-paste THIS, and it's two lines.
#
# THREE KINDS OF ENVIRONMENT:
#   skills     skills, agents, hooks and permissions only (no Umbraco): end the line with
#              `OPS_SRC=/tmp/ops bash /tmp/ops/scripts/cloud-skill-sync/cloud-skill-sync.sh`
#              instead of env-setup.sh.
#   sqlite     lean env: SDK + skills. Sessions run Umbraco on server-less SQLite.
#   sqlserver  CI-parity env: also installs Docker + caches the mssql:2022 image (~2.3 GB)
#              so sessions can run Umbraco on SQL Server exactly as GH Actions does.
#
# SKILL CHANGES NEED NOTHING: the setup registers a SessionStart hook (session-refresh.sh)
# that pulls main and re-delivers skills, agents, hooks and permissions at each session start.
#
# FORCE A REBUILD only for a change to the setup itself (env-setup.sh: SDKs, Docker, images):
# bump the `rebuild:` number and re-save. The env snapshot is cached and only busts when
# THIS field's text changes.
#
# NOTE: owner is `hifi-phil` until the repo moves to the `umbraco` org (ops #40); after the
#       move, change the clone URL to umbraco/umbraco-mcp-ops.
# rebuild: 1
rm -rf /tmp/ops && git clone --depth 1 https://github.com/hifi-phil/umbraco-mcp-ops /tmp/ops && bash /tmp/ops/scripts/cloud-skill-sync/env-setup.sh --provider sqlite   # or: sqlserver
