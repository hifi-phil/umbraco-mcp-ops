#!/bin/bash
# cloud-skill-sync — deliver the Umbraco MCP ops skills AND agents to a Claude Code cloud env.
#
# Paste this into a cloud environment's **Setup script** field (Claude Code on the web →
# environment settings). It runs once when the environment builds, BEFORE the session
# starts, clones the PUBLIC umbraco-mcp-ops repo, and copies:
#   - the listed skills            → the session skills dir  ($HOME/.claude/skills)
#   - every plugin agent definition → the session agents dir ($HOME/.claude/agents)
# Cloud routines in this environment then load/invoke those skills and can spawn the
# agents (e.g. the release-reviewer used by auto-release-loop) — with no per-repo
# marketplace marker, no committed skill files, no manual upload, and no token (public
# repo → anonymous clone; the egress proxy stays free for the routine's own GitHub work).
#
# github-ops is the shared dependency every loop references by name, so keep it listed.
#
# Refreshing: the environment snapshot is cached (~7 days); making the source repo change
# does NOT bust the cache — only editing this script (or the env's allowed hosts) does.
# Bump VERSION below and re-save to force a re-clone after a skill/agent changes.
#
# Debugging: the run log is written to $HOME/skill-sync.log (readable from inside the
# session); the environment *build* log is not visible to the session.
set -u

VERSION="2"                                   # bump to force an env-cache rebuild / re-clone
REPO="https://github.com/hifi-phil/umbraco-mcp-ops"
SKILLS_DEST="$HOME/.claude/skills"
AGENTS_DEST="$HOME/.claude/agents"
SKILLS="github-ops merge-flow triage-learnings dependabot-rollup auto-release-loop release-and-branching sync-dev"
LOG="$HOME/skill-sync.log"

mkdir -p "$SKILLS_DEST" "$AGENTS_DEST"
{
  echo "===== cloud-skill-sync v$VERSION ====="
  rm -rf /tmp/ops
  if git clone --depth 1 "$REPO" /tmp/ops; then
    # Skills: copy each listed skill dir into the skills dir.
    for s in $SKILLS; do
      src="$(find /tmp/ops/plugins -type d -path "*/skills/$s" 2>/dev/null | head -1)"
      if [ -n "$src" ]; then
        rm -rf "$SKILLS_DEST/$s"; cp -r "$src" "$SKILLS_DEST/$s"; echo "installed skill: $s"
      else
        echo "NOT FOUND in source: $s"
      fi
    done
    # Agents: copy every plugin agent definition (e.g. release-reviewer) into the agents dir.
    find /tmp/ops/plugins -type f -path "*/agents/*.md" 2>/dev/null | while read -r a; do
      cp "$a" "$AGENTS_DEST/" && echo "installed agent: $(basename "$a")"
    done
  else
    echo "ERROR: clone failed ($REPO)"
  fi
  rm -rf /tmp/ops
  echo "skills present: $(ls -1 "$SKILLS_DEST" 2>/dev/null | tr '\n' ' ')"
  echo "agents present: $(ls -1 "$AGENTS_DEST" 2>/dev/null | tr '\n' ' ')"
  echo "===== cloud-skill-sync done ====="
} 2>&1 | tee "$LOG"
exit 0
