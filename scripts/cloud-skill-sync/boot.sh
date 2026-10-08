#!/usr/bin/env bash
# boot.sh — what the cloud environment's Setup field runs, so that field stays two lines
# (see env-setup-stub.sh). Clones umbraco-mcp-ops and runs the real setup, env-setup.sh,
# which delivers the skills, agents, hooks and permissions (cloud-skill-sync.sh) and the
# credential-free heavy bits.
#
#   curl -fsSL https://raw.githubusercontent.com/hifi-phil/umbraco-mcp-ops/main/scripts/cloud-skill-sync/boot.sh -o /tmp/boot.sh && bash /tmp/boot.sh <sqlite|sqlserver>
#
# Downloaded, then run (not piped into bash), so a failed download fails the setup.
#
# NOTE: owner is `hifi-phil` until the repo moves to the `umbraco` org (ops #40).
set -e
PROVIDER="${1:-sqlite}"
rm -rf /tmp/ops-boot
git clone --depth 1 https://github.com/hifi-phil/umbraco-mcp-ops /tmp/ops-boot
bash /tmp/ops-boot/scripts/cloud-skill-sync/env-setup.sh --provider "$PROVIDER"
