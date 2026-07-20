#!/bin/bash
# cloud-skill-sync — deliver the Umbraco MCP ops skills to a Claude Code cloud environment.
#
# Paste this into a cloud environment's **Setup script** field (Claude Code on the web →
# environment settings). It runs once when the environment builds, BEFORE the session
# starts, and clones the PUBLIC umbraco-mcp-ops repo, copying the listed skills into the
# session's skills dir ($HOME/.claude/skills). Cloud routines that run in this environment
# then load and invoke those skills — with no per-repo marketplace marker, no committed
# skill files, no manual upload, and no token (the repo is public, so the clone is
# anonymous and the egress proxy stays free for the routine's own GitHub work).
#
# github-ops is the shared dependency every loop references by name, so keep it listed.
#
# Refreshing: the environment snapshot is cached (~7 days), and making the source repo
# change does NOT bust the cache — only editing this script (or the env's allowed hosts)
# does. Bump VERSION below and re-save to force a re-clone after a skill changes.
#
# Debugging: the run log is written to $HOME/skill-sync.log (readable from inside the
# session), because the environment *build* log is not visible to the session.
set -u

VERSION="1"                                   # bump to force an env-cache rebuild / re-clone
REPO="https://github.com/hifi-phil/umbraco-mcp-ops"
DEST="$HOME/.claude/skills"
SKILLS="github-ops dependabot-rollup triage-learnings merge-flow"
LOG="$HOME/skill-sync.log"

mkdir -p "$DEST"
{
  echo "===== cloud-skill-sync v$VERSION ====="
  rm -rf /tmp/ops
  if git clone --depth 1 "$REPO" /tmp/ops; then
    for s in $SKILLS; do
      src="$(find /tmp/ops/plugins -type d -path "*/skills/$s" 2>/dev/null | head -1)"
      if [ -n "$src" ]; then
        rm -rf "$DEST/$s"; cp -r "$src" "$DEST/$s"; echo "installed: $s"
      else
        echo "NOT FOUND in source: $s"
      fi
    done
  else
    echo "ERROR: clone failed ($REPO)"
  fi
  rm -rf /tmp/ops
  echo "skills present: $(ls -1 "$DEST" 2>/dev/null | tr '\n' ' ')"
  echo "===== cloud-skill-sync done ====="
} 2>&1 | tee "$LOG"
exit 0
