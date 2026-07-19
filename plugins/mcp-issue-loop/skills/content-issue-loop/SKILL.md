---
name: content-issue-loop
description: >-
  The lightweight sibling of mcp-issue-loop — works `ready-for-ai` issues on repos
  that have NO Umbraco build/test toolchain: the umbraco-mcp-ops repo (skills,
  plugins, scripts, workflows), the shared umbraco-mcp-skills source (Umbraco-MCP-Base),
  docs repos, and plugin repos. One worktree + subagent per issue (max 3 parallel),
  each driven to a CI-green PR, then iterated against review feedback until approved
  and merged. Same orchestration as mcp-issue-loop but with a docs/skill/config build
  playbook instead of the MCP-tool one — no worktree DB hooks, no `npm run test:all`,
  no MCP skills. This is the converter for the `loop-improvement` issues triage files
  on the ops repo. Trigger on "work the ready ops issues", "run the content loop",
  "action the loop-improvement issues", "convert the loop-improvement backlog".
---

# content-issue-loop

The `mcp-issue-loop` converts `ready-for-ai` issues into PRs on **Umbraco MCP repos**
(full toolchain: worktree DB hooks, `npm run test:all`, the MCP skills). Some repos
in this system aren't MCP repos and can't use that loop:

- `hifi-phil/umbraco-mcp-ops` — where triage files `loop-improvement` issues
  (skills, plugins, `scripts/`, workflows, docs).
- `umbraco/Umbraco-MCP-Base` — the shared `umbraco-mcp-skills` source.
- docs / plugin repos generally.

This skill is the loop for **those** repos. It's deliberately the *same* loop,
minus the MCP-specific build steps.

## Same as mcp-issue-loop — reuse it wholesale

Follow [`mcp-issue-loop`](../mcp-issue-loop/SKILL.md) **as-is** for everything
structural — do not restate or re-derive it:

- **Gathering** the `ready-for-ai` backlog and setting the durable `/goal`.
- **Rolling dispatch, cap 3** — one worktree + subagent per issue.
- **Review phase** — open a ready-for-review PR, watch for the human's review,
  dispatch a response subagent on `CHANGES_REQUESTED`, merge on approval.
- **Model selection** — orchestrator inherits the session model; pick per issue.
  Content work skews lighter: `sonnet` default, `haiku` for pure-docs/typo fixes,
  `opus` for intricate skill/plugin logic. **Never `fable`.**
- **Stop conditions & caps** — satisfiable `/goal`, graceful hand-back, the CI-green
  (8) and review-round (5) caps, the no-progress guard, label/issue-change handling.
- **Capturing learnings** — automatic via the same `SubagentStop`/`SessionEnd`
  hooks (this skill's subagents are recognised too). You file nothing by hand.
- **GitHub operations** (issues, PRs, CI status, branches, files) — follow the
  [`github-ops`](../../../github-ops/skills/github-ops/SKILL.md) skill: `gh` + `git`
  locally, the **GitHub MCP server** on the web. On the web there's no working tree —
  create the branch + push file contents via the MCP tools (step 1 below assumes a
  local worktree; that's the dev-machine path).

Only the **per-issue build playbook** changes. Use the one below in place of
mcp-issue-loop's build/review-response playbooks.

## What's different — the lightweight build playbook

> Completing one `ready-for-ai` issue on a **non-MCP** repo. No Umbraco toolchain.

1. **Worktree.** These repos have **no `WorktreeCreate` hooks** (no DB, no `.env`, no
   port, no `npm install`) — so a plain worktree is all you need. `EnterWorktree`
   still works in any git repo (it just does `git worktree add`); nothing hook-backed
   fires, which is correct here.
2. **Implement.** Make the change directly — markdown, a skill (`SKILL.md` +
   references), a plugin manifest, a `scripts/` change, a workflow. Follow the repo's
   own conventions:
   - Editing/creating **skills** → follow `skill-creator` conventions; keep
     `CLAUDE.md`-style always-loaded content lean.
   - Editing **plugin/marketplace manifests** → keep them valid JSON (`jq empty`).
   - Editing **bash/scripts** → `bash -n`, and `shellcheck` if available.
   - **No MCP skills, no `npm run test:all`, no Orval/generate.** Those don't apply.
3. **Run whatever checks the repo actually has.** Detect them — don't assume:
   - `umbraco-mcp-ops`: `bash plugins/mcp-issue-loop/hooks/test/run.sh` if you
     touched the capture hook; validate any JSON/YAML/bash you changed.
   - Other repos: run their documented lint/test (a `package.json` script, a linter)
     if present. A pure-docs change may have nothing to run — that's fine.
4. **Security + code review.** Run `/security-review` and `/code-review low` and fix
   findings, same as the MCP loop. For pure-prose changes there may be little to
   flag; run them anyway.
5. **Commit, push, open the PR** against the base branch (detect via
   `release-and-branching` — `umbraco-mcp-ops` and `Umbraco-MCP-Base` are main-only).
   Link the issue (`Closes #N`), ready for review, never draft. Drive CI green
   (the 8-attempt cap applies; `umbraco-mcp-ops` runs the hook-test workflow when
   `hooks/**` changes).
6. **Return** as in mcp-issue-loop (`pr-open-green` or `blocked`); leave the worktree
   for the review phase. Capture is automatic — do nothing.

## Scope guardrail

This loop still only touches issues **labelled `ready-for-ai`**. Triage files
`loop-improvement` issues **without** that label on purpose — a human decides whether
to promote one to `ready-for-ai` and hand it to this loop. Don't self-label.
