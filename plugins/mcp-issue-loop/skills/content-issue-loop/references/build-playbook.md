# The lightweight build playbook

Completing one `ready-for-ai` issue on a **non-MCP** repo. No Umbraco toolchain. This is
the per-issue prompt substituted into each build subagent, in place of `mcp-issue-loop`'s
`issue-lifecycle.md`.

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
   [`mcp-review`](../../mcp-review/SKILL.md) over it and hands back any findings. For a
   pure-prose change the review will find little — that's fine.
5. **Commit, push, open the PR** against the base branch (detect via
   `release-and-branching` — never assume it; these repos don't share one model).
   Link the issue (`Closes #N`), ready for review, never draft. `umbraco-mcp-ops` runs
   the hook-test workflow when `hooks/**` changes.
6. **Return** as in mcp-issue-loop (`pr-open`, or `blocked` with the reason); leave the
   worktree for the orchestrator. Capture is automatic — do nothing.
