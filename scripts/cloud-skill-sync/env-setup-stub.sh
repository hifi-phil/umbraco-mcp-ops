#!/usr/bin/env bash
# ── PASTE THIS (and ONLY this) into the cloud environment's Setup script field ──
#
# It clones umbraco-mcp-ops and runs the real setup script, which delivers the loop
# skills/agents/hooks AND (for the build loops) installs the .NET SDK and bakes a
# ready-to-run Umbraco (SQLite) seed per version. All the actual logic lives in
# scripts/cloud-skill-sync/env-setup.sh and is edited via PRs — you only ever
# re-paste THIS stub, and only to force a rebuild.
#
# FORCE A REBUILD: bump the `rebuild:` number below and re-save. The env snapshot is
# cached (~7 days) and only busts when THIS field's text changes — a stub that always
# pulls `main` will NOT rebuild on its own when the repo script changes. Bump the
# number whenever you want the env to re-pull (new skills, new seed, Umbraco bump, …).
#
# NOTE: owner is `hifi-phil` until the repo moves to the `umbraco` org (see ops #40);
#       after the move, change the clone URL below to umbraco/umbraco-mcp-ops.
set -e
# rebuild: 1
rm -rf /tmp/ops-boot
git clone --depth 1 https://github.com/hifi-phil/umbraco-mcp-ops /tmp/ops-boot
bash /tmp/ops-boot/scripts/cloud-skill-sync/env-setup.sh
