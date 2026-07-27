# Review agents

Spawned by the [`mcp-review`](../skills/mcp-review/SKILL.md) skill, which runs at the
top-level session of the loops.

## Ours (delivered from this repo)

- `security-reviewer.md` — a lightweight per-PR security reviewer. Delivered to
  `~/.claude/agents` by `cloud-skill-sync` alongside our skills.

## Anthropic's code-review agents (NOT vendored here)

The six `pr-review-toolkit` code-review agents (`code-reviewer`, `silent-failure-hunter`,
`pr-test-analyzer`, `type-design-analyzer`, `comment-analyzer`, `code-simplifier`) are **not
copied into this repo** — they're Anthropic's, so we take them from Anthropic's source in
both environments:

- **Cloud routine:** `cloud-skill-sync` fetches them at env-setup from
  <https://github.com/anthropics/claude-plugins-official> (`plugins/pr-review-toolkit/agents`,
  pinned to a commit — bump the pin in `scripts/cloud-skill-sync/cloud-skill-sync.sh` to
  update) and drops them into `~/.claude/agents`. Routines can't use the marketplace, and
  there's no other fetchable channel, so a pinned git fetch is the mechanism.
- **Local dev:** the official marketplace (`claude-plugins-official`, auto-installed by
  Claude Code) already provides them — nothing to fetch.

They're Apache-2.0 © Anthropic; we redistribute nothing (we fetch at build time), so no
LICENSE copy is kept here.
