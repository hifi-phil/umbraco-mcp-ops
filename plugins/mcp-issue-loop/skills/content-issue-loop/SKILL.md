---
name: content-issue-loop
description: >-
  The lightweight sibling of mcp-issue-loop — works `ready-for-ai` issues on repos
  that have NO Umbraco build/test toolchain: the umbraco-mcp-ops repo (skills,
  plugins, scripts, workflows), docs repos, and plugin repos. Not for
  Umbraco-MCP-Base — that's a full MCP repo, use mcp-issue-loop.
  One worktree + subagent per issue (max 3 parallel),
  each driven to a CI-green, mcp-reviewed PR, then handed off (human change-requests →
  rework-loop, merge → merge-flow). Same orchestration as mcp-issue-loop but with a
  docs/skill/config build playbook instead of the MCP-tool one — no worktree DB hooks, no
  `npm run test:all`, no MCP skills. This is the converter for the `loop-improvement` issues triage files
  on the ops repo. Trigger on "work the ready ops issues", "run the content loop",
  "action the loop-improvement issues", "convert the loop-improvement backlog".
---

# content-issue-loop

The `mcp-issue-loop` converts `ready-for-ai` issues into PRs on **Umbraco MCP repos**
(full toolchain: worktree DB hooks, `npm run test:all`, the MCP skills). Some repos
in this system aren't MCP repos and can't use that loop:

- `hifi-phil/umbraco-mcp-ops` — where triage files `loop-improvement` issues
  (skills, plugins, `scripts/`, workflows, docs).
- docs / plugin repos generally.

This skill is the loop for **those** repos. It's deliberately the *same* loop,
minus the MCP-specific build steps.

> **Not `umbraco/Umbraco-MCP-Base`.** It hosts the `umbraco-mcp-skills` source, but
> that's one workspace out of six — it's a TypeScript monorepo (`packages/mcp-server-sdk`,
> `packages/hosted-mcp`, `packages/create-mcp-server`, `template`, `tests/cli`) with jest,
> Playwright, worktree hooks, and a CI job that boots a real Umbraco. Use
> **`mcp-issue-loop`** there, even for a skills-only change. Before assuming any repo
> belongs here, **check for a build/test toolchain** rather than going by what the repo
> is "for".

## Same as mcp-issue-loop — reuse it wholesale

Follow [`mcp-issue-loop`](../mcp-issue-loop/SKILL.md) **as-is** for everything
structural — do not restate or re-derive it:

- **Gathering** the `ready-for-ai` backlog and setting the durable `/goal`.
- **Rolling dispatch, cap 3** — one worktree + subagent per issue.
- **CI-driving** — a build subagent returns once its branch is pushed and its PR is open;
  it never polls CI. The orchestrator polls each returned PR's check-run status until every
  check passes or the 8-attempt cap trips, re-dispatching a subagent into that same
  worktree with a failing check's log to fix it. Identical to `mcp-issue-loop` — nothing
  content-loop-specific here.
- **Review + hand off** — once a PR's CI is green, the orchestrator runs `mcp-review` over
  it, fixes findings (re-testing locally, re-greening CI). Only once that's clean/addressed
  does it do the issue's outcome-label swap, then **hands off**: no human-review phase
  here — the reviewer's change-requests go to `rework-loop` (`auto-rework`), and
  `merge-flow` merges.
- **Model selection** — orchestrator inherits the session model; pick per issue.
  Content work skews lighter: `sonnet` default, `haiku` for pure-docs/typo fixes,
  `opus` for intricate skill/plugin logic. **Never `fable`.**
- **Stop conditions & caps** — satisfiable `/goal`, graceful hand-back, the CI-green
  (8) cap, the no-progress guard, label/issue-change handling.
- **Capturing learnings** — automatic via the same `SubagentStop`/`SessionEnd`
  hooks (this skill's subagents are recognised too). You file nothing by hand.
- **GitHub operations** — use the **`github-ops`** skill (required); it owns the
  local-vs-web mechanism. Note: step 1's worktree is the dev-machine path — on the
  web there's no working tree, so `github-ops` creates the branch and pushes files
  via the API instead.

Only the **per-issue build playbook** changes. Use the one below in place of
mcp-issue-loop's build playbook.

## What's different — the lightweight build playbook

> Completing one `ready-for-ai` issue on a **non-MCP** repo. No Umbraco toolchain.

1. **Worktree.** `EnterWorktree` works in any git repo (at minimum it does
   `git worktree add`). **Check `.claude/settings.json` for `WorktreeCreate` hooks**
   rather than assuming there are none — if the repo has them they *will* fire, and a
   repo with worktree hooks is a strong sign it belongs in `mcp-issue-loop`, not here.
   For a repo with no hooks (the ops repo, docs repos), a plain worktree is all you
   need: no DB, no `.env`, no port, no `npm install`.
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
4. **CI-driving and review are the orchestrator's job — you do neither.** Don't run
   `/security-review` / `/code-review` (they can't run in a subagent and self-review is
   weak). After you return an open PR, the orchestrator drives its CI green, then runs
   [`mcp-review`](../mcp-review/SKILL.md) over it and hands back any findings. For a
   pure-prose change the review will find little — that's fine.
5. **Commit, push, open the PR** against the base branch (detect via
   `release-and-branching` — never assume it; these repos don't share one model).
   Link the issue (`Closes #N`), ready for review, never draft. CI-driving is the
   orchestrator's job from here (`umbraco-mcp-ops` runs the hook-test workflow when
   `hooks/**` changes), not yours.
6. **Return** as in mcp-issue-loop (`pr-open`, or `blocked` with the reason); leave the worktree for the orchestrator to
   drive CI green and run the review phase. Capture is automatic — do nothing.

## Scope guardrail

This loop still only touches issues **labelled `ready-for-ai`**. Triage files
`loop-improvement` issues **without** that label on purpose — a human decides whether
to promote one to `ready-for-ai` and hand it to this loop. Don't self-label.
