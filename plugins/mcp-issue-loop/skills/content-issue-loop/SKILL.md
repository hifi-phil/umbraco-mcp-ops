---
name: content-issue-loop
description: >-
  The lightweight sibling of mcp-issue-loop — works `ready-for-ai` issues on repos
  that have NO Umbraco build/test toolchain: the umbraco-mcp-ops repo (skills,
  plugins, scripts, workflows), docs repos, and plugin repos. Not for
  Umbraco-MCP-Base — that's a full MCP repo, use mcp-issue-loop. Same orchestration as
  mcp-issue-loop but with a docs/skill/config build playbook instead of the MCP-tool one.
  This is the converter for the `loop-improvement` issues triage files
  on the ops repo. Trigger on "work the ready ops issues", "run the content loop",
  "action the loop-improvement issues", "convert the loop-improvement backlog".
---

# content-issue-loop

> Not `umbraco/Umbraco-MCP-Base` — see `mcp-issue-loop`'s Config table for why (it's a
> full toolchain monorepo). Use `mcp-issue-loop` there, even for a skills-only change.
> Before assuming any repo belongs here, **check for a build/test toolchain** rather
> than going by what the repo is "for".

## Same as mcp-issue-loop — reuse it wholesale

Follow [`mcp-issue-loop`](../mcp-issue-loop/SKILL.md) **as-is** for everything
structural — do not restate or re-derive it:

- **Gathering** the `ready-for-ai` backlog and setting the durable `/goal`.
- **Rolling dispatch** — one worktree + subagent per issue, same cap as `mcp-issue-loop`.
- **CI-driving** — identical to `mcp-issue-loop`'s Step 3; nothing content-loop-specific here.
- **Review + hand off** — identical to `mcp-issue-loop`'s Step 3 (review) and Step 4
  (hand-off); nothing content-loop-specific here.
- **Model selection** — orchestrator inherits the session model; pick per issue.
  Content work skews lighter: `sonnet` default, `haiku` for pure-docs/typo fixes,
  `opus` for intricate skill/plugin logic. **Never `fable`.**
- **Stop conditions & caps** — satisfiable `/goal`, graceful hand-back, the CI-green-attempt
  cap, the no-progress guard, label/issue-change handling.
- **Capturing learnings** — automatic via the same `SubagentStop`/`SessionEnd`
  hooks (this skill's subagents are recognised too). You file nothing by hand.
- **GitHub operations** — use the **`github-ops`** skill (required); it owns the
  local-vs-web mechanism. Note: step 1's worktree is the dev-machine path — on the
  web there's no working tree, so `github-ops` creates the branch and pushes files
  via the API instead.

Only the **per-issue build playbook** changes. Use
[`references/build-playbook.md`](references/build-playbook.md) in place of
mcp-issue-loop's `issue-lifecycle.md`.

## Scope guardrail

This loop still only touches issues **labelled `ready-for-ai`**. Triage files
`loop-improvement` issues **without** that label on purpose — a human decides whether
to promote one to `ready-for-ai` and hand it to this loop. Don't self-label.
