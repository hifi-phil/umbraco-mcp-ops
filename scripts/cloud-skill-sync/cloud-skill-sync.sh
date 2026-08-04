#!/bin/bash
# cloud-skill-sync — deliver the Umbraco MCP ops skills AND agents to a Claude Code cloud env.
#
# Paste this into a cloud environment's **Setup script** field (Claude Code on the web →
# environment settings). It runs once when the environment builds, BEFORE the session
# starts, clones the PUBLIC umbraco-mcp-ops repo, and copies:
#   - the listed skills             → the session skills dir  ($HOME/.claude/skills)
#   - every plugin agent definition → the session agents dir  ($HOME/.claude/agents)
#   - Anthropic's pr-review-toolkit code-review agents (used by mcp-review), fetched at a
#     pinned commit from github.com/anthropics/claude-plugins-official → $HOME/.claude/agents
#     (routines can't use the marketplace; locally these come from the installed marketplace)
#   - the mcp-issue-loop learning hooks → $HOME/.claude/ops-hooks, then registers
#     them (SubagentStop/SessionEnd) in $HOME/.claude/settings.json so the
#     proto-learning capture that runs locally as a plugin also runs in cloud
#     sessions (installed plugins auto-wire their hooks; a copied skill does not,
#     so the setup script wires them here).
# Cloud routines in this environment then load/invoke those skills, spawn the agents
# (e.g. the release-reviewer used by auto-release-loop), and fire the capture hooks —
# with no per-repo marketplace marker, no committed skill files, no manual upload, and
# no token (public repo → anonymous clone; the egress proxy stays free for GitHub work).
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

VERSION="17"                                  # bump to force an env-cache rebuild / re-clone
REPO="https://github.com/hifi-phil/umbraco-mcp-ops"
SKILLS_DEST="$HOME/.claude/skills"
AGENTS_DEST="$HOME/.claude/agents"
HOOKS_ROOT="$HOME/.claude/ops-hooks"          # plugin-root stand-in for the capture hooks
SETTINGS="$HOME/.claude/settings.json"
SKILLS="github-ops loop-dispatch worker-env merge-flow triage-learnings dependabot-rollup auto-release-loop release-and-branching sync-dev rework-loop mcp-issue-loop content-issue-loop mcp-review issue-discuss-loop"
LOG="$HOME/skill-sync.log"

# Anthropic's pr-review-toolkit code-review agents, used by the mcp-review skill. Routines
# can't use the marketplace and there's no other channel, so we fetch them from the public
# source repo at setup and drop them in AGENTS_DEST. Pinned for reproducibility on a review
# gate — bump REVIEW_REF to update. (Locally these come from the auto-installed marketplace.)
REVIEW_REPO="https://github.com/anthropics/claude-plugins-official"
REVIEW_REF="e5635ad1f03874dbe6862f8b56f8873b8d4035dc"
REVIEW_SUBPATH="plugins/pr-review-toolkit/agents"

mkdir -p "$SKILLS_DEST" "$AGENTS_DEST"
{
  echo "===== cloud-skill-sync v$VERSION ====="
  # Source of truth: if env-setup passed the checkout it was launched from (OPS_SRC), use
  # it — so a branch-pointed env delivers THAT branch's skills (worker-env etc.). Otherwise
  # (this script pasted directly as the Setup field) clone the default branch.
  CLONED=0
  if [ -n "${OPS_SRC:-}" ] && [ -d "$OPS_SRC/plugins" ]; then
    OPS_DIR="$OPS_SRC"; echo "using provided source (no clone): $OPS_DIR"
  else
    rm -rf /tmp/ops
    if git clone --depth 1 "$REPO" /tmp/ops; then OPS_DIR=/tmp/ops; CLONED=1; fi
  fi
  if [ -n "${OPS_DIR:-}" ]; then
    # Skills: copy each listed skill dir into the skills dir.
    for s in $SKILLS; do
      src="$(find "$OPS_DIR/plugins" -type d -path "*/skills/$s" 2>/dev/null | head -1)"
      if [ -n "$src" ]; then
        rm -rf "$SKILLS_DEST/$s"; cp -r "$src" "$SKILLS_DEST/$s"; echo "installed skill: $s"
      else
        echo "NOT FOUND in source: $s"
      fi
    done
    # Agents: copy every plugin agent definition (e.g. release-reviewer) into the agents dir.
    find "$OPS_DIR/plugins" -type f -path "*/agents/*.md" 2>/dev/null | while read -r a; do
      cp "$a" "$AGENTS_DEST/" && echo "installed agent: $(basename "$a")"
    done
    # Hooks: deliver the mcp-issue-loop learning hooks (+ their schema) under a plugin-root
    # stand-in, then register them in settings.json. An installed plugin auto-wires its
    # hooks via ${CLAUDE_PLUGIN_ROOT}; a copied skill does not, so we wire them by hand.
    plug="$(find "$OPS_DIR/plugins" -maxdepth 1 -type d -name mcp-issue-loop 2>/dev/null | head -1)"
    if [ -n "$plug" ] && [ -d "$plug/hooks" ]; then
      rm -rf "$HOOKS_ROOT"
      mkdir -p "$HOOKS_ROOT/hooks" "$HOOKS_ROOT/skills/mcp-issue-loop/references"
      cp -r "$plug/hooks/." "$HOOKS_ROOT/hooks/"
      [ -f "$plug/skills/mcp-issue-loop/references/proto-learning-schema.md" ] && \
        cp "$plug/skills/mcp-issue-loop/references/proto-learning-schema.md" \
           "$HOOKS_ROOT/skills/mcp-issue-loop/references/"
      chmod +x "$HOOKS_ROOT/hooks/"*.sh 2>/dev/null || true
      echo "installed hooks: $(ls -1 "$HOOKS_ROOT/hooks" 2>/dev/null | tr '\n' ' ')"
      # Register SubagentStop + SessionEnd (idempotent). CLAUDE_PLUGIN_ROOT is set inline
      # so the capture script resolves its analyzer prompts + schema under $HOOKS_ROOT.
      if command -v jq >/dev/null 2>&1; then
        [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
        for pair in "SubagentStop subagent" "SessionEnd orchestrator"; do
          ev="${pair% *}"; scope="${pair#* }"
          cmd="CLAUDE_PLUGIN_ROOT=$HOOKS_ROOT bash $HOOKS_ROOT/hooks/capture-proto-learning.sh $scope"
          tmp="$(mktemp)"
          if jq --arg ev "$ev" --arg cmd "$cmd" '
                .hooks = (.hooks // {})
                | .hooks[$ev] = (.hooks[$ev] // [])
                | if any(.hooks[$ev][]?; any(.hooks[]?; .command == $cmd)) then .
                  else .hooks[$ev] += [ {"hooks": [ {"type":"command","command":$cmd,"async":true} ]} ] end
              ' "$SETTINGS" > "$tmp" 2>>"$LOG"; then
            mv "$tmp" "$SETTINGS"; echo "registered hook: $ev -> $scope"
          else
            rm -f "$tmp"; echo "WARN: could not register $ev hook (jq merge failed)"
          fi
        done
      else
        echo "WARN: jq missing — hooks copied but NOT registered in settings.json"
      fi
    else
      echo "NOT FOUND in source: mcp-issue-loop hooks"
    fi
  else
    echo "ERROR: no source available (clone failed: $REPO, and no OPS_SRC provided)"
  fi
  [ "$CLONED" = "1" ] && rm -rf /tmp/ops   # only remove a checkout WE cloned, not OPS_SRC

  # Anthropic's review agents — fetch the pinned commit shallowly and copy the agent files.
  # A single-commit fetch keeps it light; on failure the loop still runs with our own
  # security-reviewer, just without the pr-review-toolkit code lenses, so this never aborts.
  rt="$(mktemp -d)"
  if git -C "$rt" init -q 2>>"$LOG" \
     && git -C "$rt" remote add origin "$REVIEW_REPO" 2>>"$LOG" \
     && git -C "$rt" fetch -q --depth 1 origin "$REVIEW_REF" 2>>"$LOG" \
     && git -C "$rt" checkout -q FETCH_HEAD 2>>"$LOG" \
     && ls "$rt/$REVIEW_SUBPATH"/*.md >/dev/null 2>&1; then
    cp "$rt/$REVIEW_SUBPATH"/*.md "$AGENTS_DEST/" \
      && echo "installed review agents from $REVIEW_REPO@${REVIEW_REF:0:7}: $(ls -1 "$rt/$REVIEW_SUBPATH"/*.md | xargs -n1 basename | tr '\n' ' ')"
  else
    echo "WARN: could not fetch review agents ($REVIEW_REPO@${REVIEW_REF:0:7}) — mcp-review will run with security-reviewer only"
  fi
  rm -rf "$rt"

  echo "skills present: $(ls -1 "$SKILLS_DEST" 2>/dev/null | tr '\n' ' ')"
  echo "agents present: $(ls -1 "$AGENTS_DEST" 2>/dev/null | tr '\n' ' ')"
  echo "hooks present:  $(ls -1 "$HOOKS_ROOT/hooks" 2>/dev/null | tr '\n' ' ')"
  echo "===== cloud-skill-sync done ====="
} 2>&1 | tee "$LOG"
exit 0
